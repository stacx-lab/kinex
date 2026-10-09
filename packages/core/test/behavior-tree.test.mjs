import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { copyFile, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const globals = await mkdtemp(path.join(os.tmpdir(), 'kinex-tree-home-'))
process.env.KINEX_CONFIG_DIR = path.join(globals, 'config')
process.env.KINEX_DATA_DIR = path.join(globals, 'data')
after(() => rm(globals, { recursive: true, force: true }))
const { createKinexRuntime, PermissionDeniedError } = await import('../dist/index.js')
const input = { device: 'arm', world: 'world', joints: [.2], joint_tolerance: .001, quiet_velocity: .005 }

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kinex-tree-'))
  const runtime = createKinexRuntime({ directory, host: { ask: async () => {} } })
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  await runtime.profiles.writeManifest({ identity: { id: 'tree-test', name: 'Tree test', platform: 'real', kind: 'arm' } })
  await runtime.profiles.writeDevice({ name: 'world', type: 'world', loaded: true, access: { connection: { kind: 'mock' } } })
  await runtime.profiles.writeDevice({ name: 'arm', type: 'joint', loaded: true,
    access: { connection: { kind: 'mock' } }, intrinsics: {
      model: { format: 'joints', joints: [{ name: 'j0', type: 'revolute', limits: { min: -3, max: 3 }, max_velocity: 1, max_effort: null }] },
      home: null, control: { mode: 'position' }, feedback: { velocities: true, efforts: false },
      stop: { behavior: 'hold', affected_devices: ['arm'] },
    } })
  for (const [folder, name, files] of [['skill', 'move-and-verify', ['tree.py', 'SKILL.xml']], ['tool', 'servo', ['tool.py']]]) {
    const dir = path.join(directory, '.kinex', folder, name)
    await mkdir(dir, { recursive: true })
    for (const entry of files) await copyFile(new URL(`../assets/builtin/${folder}/${name}/${entry}`, import.meta.url), path.join(dir, entry))
    const manifest = await readFile(new URL(`../assets/builtin/${folder}/${name}/tool.yaml`, import.meta.url), 'utf8')
    await writeFile(path.join(dir, 'tool.yaml'), `${manifest}\ninterpreter: ${process.env.PYTHON ?? 'python3'}\n`)
  }
  const run = (args = {}, invocation = {}) => runtime.tools.call('move_and_verify', { ...input, ...args }, { sessionID: 'tree', ...invocation })
  return { runtime, directory, run }
}

test('tree skill discovery is inert and execution reports measured success with one submission', async t => {
  const { runtime, directory, run } = await fixture(t)
  const skill = await runtime.skills.load('move-and-verify')
  assert.equal(skill.info.format, 'xml')
  assert.equal(skill.info.tool, 'move_and_verify')
  await assert.rejects(stat(path.join(skill.info.directory, 'SKILL.md')), { code: 'ENOENT' })
  assert.match(skill.content, /move_and_verify/)
  const { tools, problems } = await runtime.tools.list()
  assert.deepEqual(problems, [])
  assert.ok(tools.some(tool => tool.name === 'move_and_verify'))
  await assert.rejects(stat(path.join(directory, '.kinex/python')), { code: 'ENOENT' })
  const response = await run()
  assert.ok(!response.isError, response.output)
  const result = JSON.parse(response.output)
  assert.equal(result.status, 'SUCCESS')
  assert.ok(result.execution_id)
  assert.deepEqual(result.measured.positions, input.joints)
  assert.ok(result.samples >= 2)
  assert.ok(result.elapsed_s >= .1)
  assert.match(result.tree, /Move and verify \[✓\]/)
  assert.deepEqual(result.trace.filter(node => node.status === 'SUCCESS').map(node => node.node.split('.').at(-1)), [
    'Validate inputs and clock', 'Submit trajectory once', 'Verify fresh quiet arrival', 'Stop owned motion', 'Move and verify',
  ])
  assert.equal((await runtime.devices.dispatch('arm', 'read')).data.stopped, true)
})

test('arrival timeout is an error and stops the submitted motion', async t => {
  const { runtime, run } = await fixture(t)
  const response = await run({ joints: [2], timeout_s: .1 })
  assert.equal(response.isError, true, response.output)
  const failure = JSON.parse(response.output)
  assert.equal(failure.code, 'arrival_timeout')
  assert.ok(failure.details.trace.some(node => node.node.endsWith('Verify fresh quiet arrival') && node.status === 'FAILURE'))
  assert.equal((await runtime.devices.dispatch('arm', 'read')).data.stopped, true)
})

test('XML discovery preserves metadata, local precedence and read-only loading', async t => {
  const { runtime, directory } = await fixture(t)
  const dir = path.join(directory, '.kinex/skill/move-and-verify')
  const file = path.join(dir, 'SKILL.xml')
  const xml = (await readFile(file, 'utf8')).replace('description="Move a loaded joint device to a target and verify fresh, quiet measured arrival."',
    'description="Local &amp; XML"').replaceAll('\n', '\r\n')
  await writeFile(file, xml)
  await writeFile(path.join(dir, 'SKILL.md'), '---\nname: move-and-verify\ndescription: superseded\n---\nLegacy text')
  const skill = await runtime.skills.load('move-and-verify')
  assert.equal(skill.info.description, 'Local & XML')
  assert.equal(skill.info.file, file)
  assert.equal(skill.content, xml)
  const loaded = await runtime.tools.call('skill', { name: 'move-and-verify' }, { sessionID: 'tree' })
  assert.match(loaded.output, /Execute this XML skill with the move_and_verify tool/)
  await assert.rejects(stat(path.join(directory, '.kinex/python')), { code: 'ENOENT' })
  await writeFile(file, xml.replace('tool="move_and_verify"', 'tool="wrong_tool"'))
  const mismatch = await runtime.tools.list()
  assert.ok(mismatch.problems.some(problem => problem.includes('XML skill tool must match')))
  await writeFile(file, xml)
  await rm(path.join(dir, 'tool.yaml'))
  assert.ok((await runtime.tools.list()).problems.some(problem => problem.includes('requires a sibling tool.yaml')))
})

test('invalid XML bundle manifests block execution fallback until repaired', async t => {
  for (const invalid of ['missing', 'mismatch', 'syntax', 'schema']) await t.test(invalid, async t => {
    const { runtime, directory, run } = await fixture(t)
    const dir = path.join(directory, '.kinex/skill/move-and-verify')
    const file = path.join(dir, 'SKILL.xml')
    const manifestFile = path.join(dir, 'tool.yaml')
    const manifest = await readFile(manifestFile, 'utf8')
    const xml = (await readFile(file, 'utf8')).replace('name="Submit trajectory once"', 'name="Local move"')
    await writeFile(file, xml)
    if (invalid === 'missing') await rm(manifestFile)
    else await writeFile(manifestFile, invalid === 'mismatch' ? manifest.replace('name: move_and_verify', 'name: other_tool')
      : invalid === 'syntax' ? 'name: [unfinished' : manifest.replace('kind: controller', 'kind: invalid'))
    const skill = await runtime.skills.load('move-and-verify')
    assert.equal(skill.info.file, file)
    assert.equal(skill.content, xml)
    const catalog = await runtime.tools.list()
    assert.ok(catalog.problems.some(problem => problem.includes(dir)))
    assert.ok(!catalog.tools.some(tool => tool.name === 'move_and_verify'), 'invalid local bundle must not expose the packaged tree')
    assert.ok(!catalog.tools.some(tool => tool.name === 'other_tool'))
    assert.ok(catalog.tools.some(tool => tool.name === 'servo'))
    assert.ok((await runtime.skills.load('setup-device')).content)
    await runtime.devices.dispatch('arm', 'write', { actions: [[.5]], duration_s: 1 })
    await assert.rejects(run(), /unknown tool "move_and_verify"/)
    assert.equal((await runtime.devices.dispatch('arm', 'read')).data.stopped, false)
    await assert.rejects(stat(path.join(directory, '.kinex/python')), { code: 'ENOENT' })
    await writeFile(manifestFile, manifest)
    assert.deepEqual((await runtime.tools.list()).problems, [])
    const repaired = await run()
    assert.ok(!repaired.isError, repaired.output)
    assert.match(JSON.parse(repaired.output).tree, /Local move/)
  })
})

test('malformed XML preserves valid skills and context, and recovers after repair', async t => {
  const { runtime, directory } = await fixture(t)
  const dir = path.join(directory, '.kinex/skill/broken-tree')
  const file = path.join(dir, 'SKILL.xml')
  await mkdir(dir, { recursive: true })
  const xml = (await readFile(new URL('../assets/builtin/skill/move-and-verify/SKILL.xml', import.meta.url), 'utf8'))
    .replace('name="move-and-verify"', 'name="broken-tree"').replace('tool="move_and_verify"', 'tool="broken_tree"')
  const manifest = await readFile(new URL('../assets/builtin/skill/move-and-verify/tool.yaml', import.meta.url), 'utf8')
  await writeFile(path.join(dir, 'tool.yaml'), manifest.replace('name: move_and_verify', 'name: broken_tree'))
  for (const invalid of ['<root>', '<!DOCTYPE root><root/>', '<root name="broken-tree"/>']) {
    await writeFile(file, invalid)
    const skills = await runtime.skills.list()
    assert.ok(skills.some(skill => skill.name === 'setup-device'))
    assert.ok(skills.some(skill => skill.name === 'move-and-verify'))
    assert.ok(!skills.some(skill => skill.name === 'broken-tree'))
    assert.ok((await runtime.skills.load('setup-device')).content)
    const loaded = await runtime.tools.call('skill', { name: 'setup-device' }, { sessionID: 'tree' })
    assert.match(loaded.output, /<skill_content name="setup-device">/)
    const context = await runtime.context()
    assert.match(context.skills, /setup-device/)
    assert.match(context.skills, /move-and-verify/)
    assert.match(context.skills, /<skill_problems>/)
    assert.ok(context.skills.includes(file))
    const catalog = await runtime.tools.list()
    assert.ok(catalog.problems.some(problem => problem.includes(file)))
    assert.ok(!catalog.tools.some(tool => tool.name === 'broken_tree'))
    await assert.rejects(stat(path.join(directory, '.kinex/python')), { code: 'ENOENT' })
  }
  await writeFile(file, xml)
  assert.equal((await runtime.skills.load('broken-tree')).content, xml)
  const context = await runtime.context()
  assert.match(context.skills, /broken-tree/)
  assert.doesNotMatch(context.skills, /<skill_problems>/)
  assert.deepEqual((await runtime.tools.list()).problems, [])
})

test('execution uses the selected XML bundle and rejects unknown leaves before motion', async t => {
  const { runtime, directory, run } = await fixture(t)
  const file = path.join(directory, '.kinex/skill/move-and-verify/SKILL.xml')
  const xml = await readFile(file, 'utf8')
  await writeFile(file, xml.replace('name="Submit trajectory once"', 'name="Custom move"'))
  const result = await run()
  assert.ok(!result.isError, result.output)
  assert.match(JSON.parse(result.output).tree, /Custom move/)
  await runtime.devices.dispatch('arm', 'write', { actions: [[.5]], duration_s: 1 })
  await writeFile(file, xml.replace('<Move ', '<Unknown '))
  const rejected = await run()
  assert.equal(rejected.isError, true)
  assert.match(rejected.output, /unknown/i)
  assert.equal((await runtime.devices.dispatch('arm', 'read')).data.stopped, false)
})

test('invalid tree inputs and denied controller permission preserve existing motion', async t => {
  const { runtime, run } = await fixture(t)
  await runtime.devices.dispatch('arm', 'write', { actions: [[.5]], duration_s: 1 })
  for (const args of [{ joint_tolerance: [0.01, 0.01] }, { stable_s: 2, timeout_s: 1 }, { joints: [9] }, { quiet_velocity: 0 }]) {
    const response = await run(args)
    assert.equal(response.isError, true, response.output)
  }
  let requested
  await assert.rejects(run({}, { ask: async ({ permission }) => {
    requested = permission
    throw new PermissionDeniedError(permission)
  } }), PermissionDeniedError)
  assert.equal(requested, 'python_tool_controller')
  assert.equal((await runtime.devices.dispatch('arm', 'read')).data.stopped, false)
  await runtime.devices.dispatch('world', 'wait', { duration_s: 1 })
  assert.deepEqual((await runtime.devices.dispatch('arm', 'read')).data.positions, [.5])
})

test('cached arrival feedback never becomes success merely because world time advances', async t => {
  const { runtime, directory, run } = await fixture(t)
  await runtime.devices.unload('arm')
  await runtime.profiles.writeDevice({ name: 'arm', access: { driver: {
    interpreter: process.env.PYTHON ?? 'python3', persistent: true, timeout_s: 5,
    actions: ['load', 'unload', 'status', 'read', 'write', 'stop'],
  } } })
  await writeFile(path.join(directory, '.kinex/devices/arm/driver.py'), `from kinex.driver_protocol import run
positions = [0]
def state():
    return dict(positions=positions, velocities=[0], efforts=[], faults=[], timestamp=0)
def dispatch(action, args):
    global positions
    if action == 'read': return dict(ok=True, **state())
    if action == 'write':
        positions = args['actions'][-1]
        return dict(ok=True, execution_id='cached-test', state=state())
    return dict(ok=True)
run(dispatch, lambda: None)
`)
  await (await runtime.devices.load('arm')).ready
  const response = await run({ timeout_s: .2 })
  assert.equal(response.isError, true, response.output)
  assert.equal(JSON.parse(response.output).code, 'arrival_timeout')
})

test('host cancellation stops tree motion but preserves a newer owner', { timeout: 30000 }, async t => {
  for (const replace of [false, true]) await t.test(replace ? 'replacement' : 'owned', async t => {
    const { runtime, directory, run } = await fixture(t)
    await runtime.devices.unload('world')
    await runtime.profiles.writeDevice({ name: 'world', access: { connection: { kind: 'process' }, driver: {
      interpreter: process.env.PYTHON ?? 'python3', persistent: true, timeout_s: 5,
      actions: ['load', 'unload', 'status', 'read', 'wait'],
    } } })
    const dir = path.join(directory, '.kinex/devices/world')
    await copyFile(new URL('./fixtures/world-wait-driver.py', import.meta.url), path.join(dir, 'driver.py'))
    await writeFile(path.join(dir, 'behavior.json'), '{}')
    await (await runtime.devices.load('world')).ready
    const abort = new AbortController()
    t.after(() => abort.abort())
    let finished = false
    const pending = run({ joints: [2], wait_s: 1 }, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]) })
    void pending.finally(() => { finished = true })
    const deadline = Date.now() + 7000
    let waiting = false
    while (!finished && Date.now() < deadline) {
      if ((await runtime.devices.ping('world')).reading.data.waiting > 0) { waiting = true; break }
      await delay(10)
    }
    assert.ok(waiting, 'tree must reach a real outstanding world wait')
    if (replace) await runtime.devices.dispatch('arm', 'write', { actions: [[.5]], duration_s: 1 })
    abort.abort()
    const response = await pending
    assert.equal(response.isError, true, response.output)
    assert.equal((await runtime.devices.dispatch('arm', 'read')).data.stopped, !replace)
  })
})

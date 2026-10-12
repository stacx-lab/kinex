import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import path from 'node:path'
import { isolate, fakeProvider, workspace, bind, seed } from './helpers.mjs'
const isolation = await isolate()
after(isolation.cleanup)
const { createApplication } = await import('../dist/application.js')

test('headless context includes one short Python instruction without onboarding or environment creation', async t => {
  const cwd = await workspace(t)
  const fake = await fakeProvider(t, isolation.root)
  const app = await createApplication({ cwd, model: 'fake/test', mode: 'auto' })
  t.after(() => app.dispose())
  await bind(app)
  await app.host.session.prompt('Describe the available Python environment without running tools')
  const request = fake.requests[0]
  const system = JSON.stringify(request.messages.filter(message => message.role === 'system' || message.role === 'developer'))
  assert.equal(system.match(/Kinex core Python:/g)?.length, 1)
  assert.match(system, /uv add\/uv sync/)
  assert.doesNotMatch(system, /Default pyproject\.toml|\{\{PROJECT\}\}/)
  const context = await app.owner.runtime.context()
  assert.ok(JSON.stringify(request).includes(context.python.executable))
  assert.equal(context.python.present, false)
  await assert.rejects(stat(path.join(cwd, '.kinex/python')), { code: 'ENOENT' })
})

test('direct commands need no model and preserve the robotics workspace', async t => {
  const cwd = await workspace(t)
  const outputs = []
  const app = await createApplication({ cwd, report: text => outputs.push(text) })
  t.after(() => app.dispose())
  await seed(app.owner.runtime)
  await bind(app)
  const commands = app.host.session.extensionRunner.getRegisteredCommands().map(command => command.name)
  assert.ok(!commands.some(name => name.startsWith('kinex-')), 'only short Kinex command names are exposed')
  for (const name of ['register', 'unregister', 'devices', 'load', 'unload', 'ping', 'stop', 'record', 'onboarding', 'calibrate', 'mode']) {
    assert.equal(commands.filter(command => command === name).length, 1, `${name} is registered once`)
  }
  assert.ok(!commands.includes('reload'), 'Pi exclusively owns /reload')
  assert.deepEqual(app.host.session.extensionRunner.getCommandDiagnostics(), [])
  for (const command of ['/load sensor', '/devices', '/ping sensor', '/stop sensor', '/unload sensor']) await app.host.session.prompt(command)
  assert.match(outputs.join('\n'), /sensor loaded/)
  assert.equal((await app.owner.runtime.devices.list())[0].loaded, false)
  for (const entry of ['.pi', '.kinex/python']) await assert.rejects(stat(path.join(cwd, entry)), { code: 'ENOENT' })
})

test('headless permission denial prevents coding side effects', async t => {
  const cwd = await workspace(t)
  const fake = await fakeProvider(t, isolation.root)
  fake.steps.push({ tool: 'write', args: { path: 'forbidden.txt', content: 'no' } })
  const app = await createApplication({ cwd, model: 'fake/test' })
  t.after(() => app.dispose())
  await bind(app)
  await app.host.session.prompt('write something')
  await assert.rejects(stat(path.join(cwd, 'forbidden.txt')), { code: 'ENOENT' })
  assert.equal(fake.requests.length, 1)
})

test('same-workspace replacement retains drivers and finalizes recording', async t => {
  const cwd = await workspace(t)
  await fakeProvider(t, isolation.root)
  const app = await createApplication({ cwd, model: 'fake/test', mode: 'auto' })
  t.after(() => app.dispose())
  const core = app.owner.runtime
  await seed(core)
  await bind(app)
  await app.host.session.prompt('/load sensor')
  await core.devices.dispatch('sensor', 'stop')
  await app.host.session.prompt('/record start sensor=2')
  assert.ok(await core.recording.status())
  app.host.setRebindSession(() => bind(app))
  await app.host.newSession()
  assert.equal(app.owner.runtime, core)
  assert.equal((await core.devices.dispatch('sensor', 'read')).data.stopped, true)
  assert.equal(await core.recording.status(), undefined)
  const recent = await core.recording.recent()
  assert.equal(recent.length, 1)
  assert.equal(recent[0].status, 'stopped')
  await app.host.session.reload()
  assert.equal(app.owner.runtime, core)
})

for (const source of ['file', 'camera']) test(`${source} images are stored as bytes and survive session resume`, async t => {
  const cwd = await workspace(t)
  const fake = await fakeProvider(t, isolation.root)
  let png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6rXcAAAAASUVORK5CYII=', 'base64')
  const image = path.join(cwd, 'frame.png')
  const app = await createApplication({ cwd, model: 'fake/test', mode: 'auto' })
  t.after(() => app.dispose())
  if (source === 'file') {
    await writeFile(image, png)
    await mkdir(path.join(cwd, '.kinex/tool'), { recursive: true })
    await writeFile(path.join(cwd, '.kinex/tool/capture.ts'), `export default { description: 'Capture test image', execute: async () => ({title:'frame',output:'frame',attachments:[{mime:'image/png',path:${JSON.stringify(image)}}]}) }`)
    fake.steps.push({ tool: 'capture' })
  } else {
    await seed(app.owner.runtime)
    await app.owner.runtime.profiles.writeDevice({ name: 'camera', type: 'rgb', loaded: true,
      access: { connection: { kind: 'mock' } }, intrinsics: {
        color: { width: 2, height: 2, pixel_format: 'rgb8', image_format: 'png' },
      } })
    png = Buffer.from((await app.owner.runtime.devices.dispatch('camera', 'read')).data.color, 'base64')
    fake.steps.push({ tool: 'device', args: { deviceID: 'camera' } })
  }
  fake.steps.push({ text: 'seen' })
  await bind(app)
  await app.host.session.prompt('look')
  assert.equal(fake.requests.length, 2)
  assert.match(JSON.stringify(fake.requests[1]), /data:image\/png;base64/)
  if (source === 'camera') await assert.rejects(stat(path.join(cwd, '.kinex/devices/camera/out')), { code: 'ENOENT' })
  const session = app.host.session.sessionFile
  await app.dispose()
  if (source === 'file') await writeFile(image, 'replaced')
  const resumed = await createApplication({ cwd, session, mode: 'auto' })
  t.after(() => resumed.dispose())
  await bind(resumed)
  await resumed.host.session.prompt('look again')
  assert.match(JSON.stringify(fake.requests.at(-1)), new RegExp(png.toString('base64').replace(/[+]/g, '\\+')))
})

test('guided workflows wait for the SDK response and recordings reference persisted messages', async t => {
  const cwd = await workspace(t)
  const fake = await fakeProvider(t, isolation.root)
  const app = await createApplication({ cwd, model: 'fake/test', mode: 'auto' })
  t.after(() => app.dispose())
  await seed(app.owner.runtime)
  await bind(app)
  await app.host.session.prompt('/load sensor')
  await app.host.session.prompt('/record start sensor=2')
  for (const command of ['onboarding', 'register', 'calibrate']) {
    const requests = fake.requests.length
    const objective = `inspect the sensor via ${command}`
    await app.host.session.prompt(`/${command} ${objective}`)
    assert.equal(fake.requests.length, requests + 1)
    const prompt = fake.requests.at(-1).messages.filter(message => message.role === 'user')
      .map(message => typeof message.content === 'string' ? message.content : message.content.map(block => block.text ?? '').join('\n'))
      .findLast(text => text.includes(objective))
    assert.match(prompt, /inspect the sensor/)
    if (command === 'onboarding') assert.match(prompt, /onboard-ros2/)
  }
  const timing = app.host.session.sessionManager.getEntries().filter(entry => entry.type === 'custom' && entry.customType === 'kinex-active-time')
  assert.ok(timing.length >= 3)
  assert.ok(timing.every(entry => entry.data.milliseconds > 0))
  assert.doesNotMatch(JSON.stringify(fake.requests), /kinex-active-time/)
  await app.host.session.prompt('/record stop success checked')
  await app.dispose()
  const dirs = await import('node:fs/promises').then(fs => fs.readdir(path.join(cwd, '.kinex/recordings')))
  const trace = JSON.parse(await readFile(path.join(cwd, '.kinex/recordings', dirs[0], 'trace.json'), 'utf8'))
  assert.match(JSON.stringify(trace), /FAKE_REPLY_OK/)
  assert.ok(trace.messages.every(message => message.id))
})

test('new and removed workspace tools refresh at the next prompt', async t => {
  const cwd = await workspace(t)
  const fake = await fakeProvider(t, isolation.root)
  const app = await createApplication({ cwd, model: 'fake/test', mode: 'auto' })
  t.after(() => app.dispose())
  await bind(app)
  const directory = path.join(cwd, '.kinex/tool')
  await mkdir(directory, { recursive: true })
  const file = path.join(directory, 'new_tool.ts')
  await writeFile(file, `export default {description:'New tool',execute:async()=>({title:'new',output:'DYNAMIC_TOOL_OK'})}`)
  fake.steps.push({ tool: 'new_tool' }, { text: 'done' })
  await app.host.session.prompt('use new tool')
  assert.match(JSON.stringify(fake.requests[1]), /DYNAMIC_TOOL_OK/)
  await rm(file)
  await app.host.session.prompt('after removal')
  assert.ok(!fake.requests.at(-1).tools.some(tool => tool.function.name === 'new_tool'))
})

test('cancellation terminates an SDK shell child and leaves the runtime usable', { timeout: 15000 }, async t => {
  const cwd = await workspace(t)
  const fake = await fakeProvider(t, isolation.root)
  fake.steps.push({ tool: 'bash', args: { command: 'echo $$ > shell.pid; sleep 30' } })
  const app = await createApplication({ cwd, model: 'fake/test', mode: 'auto' })
  t.after(() => app.dispose())
  await bind(app)
  const pending = app.host.session.prompt('run a long shell command')
  let pid
  for (let attempt = 0; attempt < 100; attempt++) {
    try { pid = Number(await readFile(path.join(cwd, 'shell.pid'), 'utf8')); break } catch { await delay(20) }
  }
  assert.ok(pid)
  await app.host.session.abort()
  await pending
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  await app.host.session.prompt('/devices')
})

test('workspace switch disposes the old robotics owner and binds the target directory', async t => {
  const cwd = await workspace(t)
  const next = await workspace(t)
  await fakeProvider(t, isolation.root)
  const target = await createApplication({ cwd: next, model: 'fake/test', mode: 'auto' })
  t.after(() => target.dispose())
  await bind(target)
  await target.host.session.prompt('create target history')
  const session = target.host.session.sessionFile
  await target.dispose()
  const app = await createApplication({ cwd, model: 'fake/test', mode: 'auto' })
  t.after(() => app.dispose())
  await seed(app.owner.runtime)
  await bind(app)
  const old = app.owner.runtime
  app.host.setRebindSession(() => bind(app))
  await app.host.switchSession(session)
  assert.throws(() => old.devices.list(), /disposed/)
  assert.equal(app.owner.runtime.directory, next)
  assert.deepEqual(await app.owner.runtime.devices.list(), [])
})

test('SDK configuration reload keeps isolation and nested cwd preserves the ancestor robot workspace', async t => {
  const cwd = await workspace(t)
  const fake = await fakeProvider(t, isolation.root)
  const parent = await createApplication({ cwd, model: 'fake/test', mode: 'auto' })
  await seed(parent.owner.runtime)
  await parent.dispose()
  const nested = path.join(cwd, 'nested')
  await mkdir(path.join(nested, '.pi'), { recursive: true })
  await writeFile(path.join(nested, '.pi', 'SYSTEM.md'), 'PI_PROMPT_MUST_NOT_APPEAR')
  await writeFile(path.join(nested, '.pi', 'settings.json'), '{"defaultModel":"DO_NOT_USE"}')
  const app = await createApplication({ cwd: nested, model: 'fake/test', mode: 'auto' })
  t.after(() => app.dispose())
  await bind(app)
  await app.host.session.reload()
  assert.equal((await app.owner.runtime.devices.list())[0].name, 'sensor')
  await assert.rejects(stat(path.join(nested, '.kinex')), { code: 'ENOENT' })
  await app.host.session.prompt('inspect')
  assert.doesNotMatch(JSON.stringify(fake.requests), /PI_PROMPT_MUST_NOT_APPEAR/)
  for (const name of ['read', 'bash', 'write', 'edit', 'find', 'grep', 'ls']) assert.ok(fake.requests[0].tools.some(tool => tool.function.name === name), name)
  assert.equal(app.host.services.settingsManager.getEnableInstallTelemetry(), false)
})


test('composition owns setup discovery and reservations across session and workspace replacement', async t => {
  const { coreContribution } = await import('@kinex/core/integration')
  const { createKinexSetup, setupContribution, setupSkillRoots, setupToolNames } = await import('@kinex/setup')
  await fakeProvider(t, isolation.root)
  for (const kind of ['default', 'core', 'custom']) {
    await t.test(kind, async t => {
      const cwd = await workspace(t)
      const next = await workspace(t)
      const target = await createApplication({ cwd: next, model: 'fake/test', mode: 'auto' })
      await bind(target)
      await target.host.session.prompt('create target history')
      const session = target.host.session.sessionFile
      await target.dispose()
      for (const directory of [cwd, next]) {
        await mkdir(path.join(directory, '.kinex/tool'), { recursive: true })
        await writeFile(path.join(directory, '.kinex/tool/setup_plan.ts'), "export default { description:'workspace planner', execute:async()=>({title:'test',output:'workspace'}) }")
      }
      const composition = kind === 'default' ? undefined : kind === 'core'
        ? { contributions: runtime => [coreContribution(runtime)] }
        : { builtinSkillRoots: setupSkillRoots, reservedToolNames: setupToolNames,
            contributions: runtime => [coreContribution(runtime), setupContribution(createKinexSetup(runtime))] }
      const app = await createApplication({ cwd, model: 'fake/test', mode: 'auto', composition })
      t.after(() => app.dispose())
      await bind(app)
      app.host.setRebindSession(() => bind(app))
      const check = async () => {
        const core = app.owner.runtime
        const setup = kind !== 'core'
        assert.equal((await core.skills.list()).some(skill => skill.name === 'onboard-ros2'), setup)
        assert.equal(app.host.session.getAllTools().some(tool => tool.name === 'calib_compute'), setup)
        assert.equal(Boolean(app.host.session.extensionRunner.getCommand('onboarding')), setup)
        for (const name of ['onboarding-ros2', 'kinex-onboarding-ros2'])
          assert.equal(app.host.session.extensionRunner.getCommand(name), undefined)
        const tools = await core.tools.list()
        assert.equal(tools.tools.some(tool => tool.name === 'setup_plan'), !setup)
        await assert.rejects(stat(path.join(core.directory, '.kinex/python')), { code: 'ENOENT' })
      }
      await check()
      if (kind === 'custom') composition.contributions = () => { throw new Error('mutated composition must not replace the selected factory') }
      await app.host.newSession()
      await check()
      await app.host.switchSession(session)
      assert.equal(app.owner.runtime.directory, next)
      await check()
    })
  }
})

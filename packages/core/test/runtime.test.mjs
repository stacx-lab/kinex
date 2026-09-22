import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, utimes } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
const globals = await mkdtemp(path.join(os.tmpdir(), 'kinex-node-home-'))
process.env.KINEX_CONFIG_DIR = path.join(globals, 'config')
process.env.KINEX_DATA_DIR = path.join(globals, 'data')
after(() => rm(globals, { recursive: true, force: true }))
const { createKinexRuntime, PermissionDeniedError } = await import('../dist/index.js')

const host = { ask: async () => {}, questions: async () => ({}) }
async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kinex-node-'))
  const runtime = createKinexRuntime({ directory, ...options })
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  await runtime.profiles.writeManifest({ identity: { id: 'node-test', name: 'Node test', platform: 'real', kind: 'arm' } })
  await runtime.profiles.writeDevice({ name: 'sensor', type: 'other', loaded: true, access: { connection: { kind: 'mock' } } })
  return { runtime, directory }
}
const driver = `import os, time
from kinex.driver_protocol import run
calls = 0
def dispatch(action, args):
    global calls
    if args.get("sleep"): time.sleep(args["sleep"])
    if args.get("noisy"): os.write(2, b"x" * 1024 * 1024)
    calls += 1
    return {"ok": True, "pid": os.getpid(), "calls": calls, **args}
def close():
    with open("closed", "a") as output: output.write(str(os.getpid()) + "\\n")
run(dispatch, close)
`
async function pythonDriver(runtime, directory, persistent = true) {
  await runtime.profiles.writeDevice({ name: 'sensor', access: { connection: { kind: 'process' }, driver: {
    interpreter: 'python3', persistent, actions: ['load', 'unload', 'status', 'read', 'write', 'stop'], timeout_s: 2,
  } } })
  const dir = path.join(directory, '.kinex', 'devices', 'sensor')
  await writeFile(path.join(dir, 'driver.py'), driver)
  return dir
}

test('importing and constructing the runtime installs no process handlers', async () => {
  const before = process.eventNames().map(name => [name, process.listenerCount(name)])
  const runtime = createKinexRuntime({ directory: '/tmp' })
  await runtime.dispose()
  assert.deepEqual(process.eventNames().map(name => [name, process.listenerCount(name)]), before)
  assert.equal(globalThis.Bun, undefined)
})

test('core discovery and context contain robotics tools and packaged assets', async t => {
  const { runtime } = await fixture(t)
  const { tools, problems } = await runtime.tools.list()
  assert.deepEqual(problems, [])
  assert.ok(tools.some(tool => tool.name === 'device'))
  for (const name of ['shell', 'read', 'write', 'edit', 'todo', 'record']) assert.ok(!tools.some(tool => tool.name === name))
  const skill = await runtime.skills.load('setup-device')
  assert.ok(skill.content.length > 100)
  assert.ok((await runtime.devices.templates()).some(entry => entry.type === 'rgb'))
  assert.ok((await runtime.context()).robotics.includes('sensor'))
  assert.ok((await runtime.calibration.plan()).items)
})

test('two runtimes isolate mock state and observers even in the same workspace', async t => {
  const { runtime: a, directory } = await fixture(t)
  const b = createKinexRuntime({ directory })
  t.after(() => b.dispose())
  const seenA = [], seenB = []
  a.subscribe(event => seenA.push(event)); b.subscribe(event => seenB.push(event))
  await a.devices.dispatch('sensor', 'stop')
  assert.equal((await a.devices.dispatch('sensor', 'read')).data.stopped, true)
  assert.equal((await b.devices.dispatch('sensor', 'read')).data.stopped, false)
  assert.equal(seenA.length, 2); assert.equal(seenB.length, 1)
  await a.dispose(); await a.dispose()
  assert.throws(() => a.devices.list(), /disposed/)
  assert.ok(await b.devices.dispatch('sensor', 'read'))
})

test('tool permissions, validation and permission-checked lifecycle survive extraction', async t => {
  const { runtime, directory } = await fixture(t)
  await pythonDriver(runtime, directory)
  await assert.rejects(runtime.tools.call('device', { deviceID: 'sensor' }, { sessionID: 's' }), PermissionDeniedError)
  const invalid = await runtime.tools.call('device', { deviceID: 1 }, { sessionID: 's' })
  assert.equal(invalid.isError, true)
  await assert.rejects(runtime.tools.call('device', { deviceID: 'sensor', action: 'load' }, { sessionID: 's' }), PermissionDeniedError)
})

test('persistent drivers serialize calls, drain stderr, reload and dispose', async t => {
  const { runtime, directory } = await fixture(t, { host })
  const dir = await pythonDriver(runtime, directory)
  const ready = await runtime.devices.load('sensor'); await ready.ready
  const replies = await Promise.all(Array.from({ length: 12 }, (_, index) => runtime.devices.dispatch('sensor', 'read', { index, noisy: true })))
  assert.equal(new Set(replies.map(reply => reply.data.pid)).size, 1)
  assert.deepEqual(replies.map(reply => reply.data.index), Array.from({ length: 12 }, (_, i) => i))
  const pid = replies[0].data.pid
  const reload = await runtime.devices.reload('sensor'); await reload.ready
  assert.ok((await readFile(path.join(dir, 'closed'), 'utf8')).includes(String(pid)))
  const next = await runtime.devices.ping('sensor')
  assert.notEqual(next.reading.data.pid, pid)
  await runtime.dispose()
  assert.throws(() => process.kill(next.reading.data.pid, 0), { code: 'ESRCH' })
})

test('one-shot drivers release connections, and cancellation terminates persistent calls', async t => {
  const { runtime, directory } = await fixture(t, { host })
  await pythonDriver(runtime, directory, false)
  const first = await runtime.devices.dispatch('sensor', 'read')
  const second = await runtime.devices.dispatch('sensor', 'read')
  assert.notEqual(first.data.pid, second.data.pid)
  await pythonDriver(runtime, directory, true)
  await (await runtime.devices.load('sensor')).ready
  const pending = runtime.devices.dispatch('sensor', 'read', { sleep: 30 }, AbortSignal.timeout(100))
  await assert.rejects(pending, /aborted|timeout/i)
  await assert.rejects(runtime.devices.dispatch('sensor', 'read'), /inactive/)
  await (await runtime.devices.load('sensor')).ready
  const healthy = await runtime.devices.dispatch('sensor', 'read')
  assert.ok(healthy.data.pid)
  const blocked = runtime.devices.dispatch('sensor', 'read', { sleep: 30 })
  const rejected = assert.rejects(blocked, /disposed/)
  await delay(30)
  await runtime.dispose()
  await rejected
})

test('dynamic TypeScript and JavaScript tools reload under Node', async t => {
  const { runtime, directory } = await fixture(t)
  const dir = path.join(directory, '.kinex', 'tool')
  await mkdir(dir, { recursive: true })
  const source = label => `const label: string = ${JSON.stringify(label)}; export default { description: label, execute: async () => ({ title: label, output: label }) }`
  const file = path.join(dir, 'custom.ts')
  await writeFile(file, source('first'))
  assert.equal((await runtime.tools.call('custom', {}, { sessionID: 's' })).output, 'first')
  await writeFile(file, source('second')); await utimes(file, new Date(), new Date(Date.now() + 5000))
  assert.equal((await runtime.tools.call('custom', {}, { sessionID: 's' })).output, 'second')
  await writeFile(path.join(dir, 'plain.js'), 'export default { description: "js", execute: async () => ({title:"js", output:"js"}) }')
  assert.equal((await runtime.tools.call('plain', {}, { sessionID: 's' })).output, 'js')
})

test('Python tools use the packaged client and drain noisy stderr', async t => {
  const { runtime, directory } = await fixture(t, { host })
  const dir = path.join(directory, '.kinex', 'tool', 'node_python')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'tool.yaml'), 'name: node_python\nkind: perception\ndescription: test\ninterpreter: python3\n')
  await writeFile(path.join(dir, 'tool.py'), 'import os\nfrom kinex import robot, finish\nos.write(2, b"x" * 1024 * 1024)\nfinish(robot())\n')
  const result = await runtime.tools.call('node_python', {}, { sessionID: 's' })
  assert.ok(!result.isError, result.output)
  assert.equal(JSON.parse(result.output).identity.id, 'node-test')
})

test('recording works concurrently in two runtimes and finalizes on disposal', async t => {
  const { runtime: a, directory: dirA } = await fixture(t, { host, enableRecording: true })
  const { runtime: b, directory: dirB } = await fixture(t, { host, enableRecording: true })
  const inputs = { specs: { sensor: { rate: 20 } }, sessionID: 'recording' }
  const [first, second] = await Promise.all([a.recording.start(inputs), b.recording.start(inputs)])
  assert.equal(first.manifest.status, 'recording'); assert.equal(second.manifest.status, 'recording')
  await delay(120)
  await a.devices.dispatch('sensor', 'read')
  await a.recording.snap({ devices: ['sensor'], sessionID: 'recording' })
  await a.dispose()
  assert.equal((await b.recording.status()).status, 'recording')
  await b.dispose()
  for (const [dir, manifest] of [[dirA, first.manifest], [dirB, second.manifest]]) {
    const saved = JSON.parse(await readFile(path.join(dir, '.kinex', 'recordings', manifest.id, 'recording.json'), 'utf8'))
    assert.equal(saved.status, 'stopped'); assert.equal(saved.endedBy, 'exit')
    assert.ok(saved.devices.sensor.events > 0)
  }
})

test('disposal flushes every deferred transcript without leaving export timers', async t => {
  const exported = []
  const { runtime } = await fixture(t, { host: { ...host, exportTrace: async (sessionID, range) => {
    exported.push({ sessionID, range }); return { sessionID, range }
  } } })
  for (const sessionID of ['first', 'second']) {
    await runtime.recording.start({ specs: { sensor: { rate: 1 } }, sessionID })
    runtime.observe({ type: 'message', sessionID, id: sessionID, completed: false })
    await runtime.recording.stop({ fromTool: true })
  }
  await runtime.dispose()
  assert.deepEqual(exported.map(entry => entry.sessionID).sort(), ['first', 'second'])
})

test('startup reserves initialization before reads and restores it in a new runtime', async t => {
  const { runtime, directory } = await fixture(t, { host })
  const dir = await pythonDriver(runtime, directory)
  await writeFile(path.join(dir, 'driver.py'), `import os, time
from kinex.driver_protocol import run
ready = False
loads = 0
def dispatch(action, args):
    global ready, loads
    if action == "load":
        time.sleep(0.1)
        ready = True
        loads += 1
    if action == "read" and not ready: raise RuntimeError("LOAD_HOOK_NOT_RUN")
    return {"ok": True, "ready": ready, "loads": loads, "pid": os.getpid()}
run(dispatch, lambda: None)
`)
  const [first, repeated] = await Promise.all([runtime.devices.warmLoaded(), runtime.devices.warmLoaded()])
  assert.equal(first, repeated)
  const reading = await runtime.devices.dispatch('sensor', 'read')
  assert.equal(reading.data.ready, true)
  assert.equal(reading.data.loads, 1)
  await runtime.dispose()
  const next = createKinexRuntime({ directory, host })
  t.after(() => next.dispose())
  await next.devices.warmLoaded()
  const restored = await next.devices.dispatch('sensor', 'read')
  assert.equal(restored.data.ready, true)
  assert.notEqual(restored.data.pid, reading.data.pid)
})

test('startup failures identify individual devices and shutdown cancels slow initialization', async t => {
  const { runtime, directory } = await fixture(t, { host })
  const dir = await pythonDriver(runtime, directory)
  await writeFile(path.join(dir, 'driver.py'), `import time
from kinex.driver_protocol import run
def dispatch(action, args):
    if action == "load": time.sleep(30)
    return {"ok": True}
run(dispatch, lambda: None)
`)
  await runtime.profiles.writeDevice({ name: 'broken', type: 'other', loaded: true, access: {
    connection: { kind: 'process' }, driver: { interpreter: 'python3', actions: ['load', 'read'], timeout_s: 1 },
  } })
  const activations = await runtime.devices.warmLoaded()
  const broken = activations.find(value => value.device.name === 'broken')
  await assert.rejects(broken.ready, /broken|driver/i)
  const slow = activations.find(value => value.device.name === 'sensor')
  const canceled = assert.rejects(slow.ready, /disposed/)
  await runtime.dispose()
  await canceled
})

test('core Python status is inert and initialization preserves the host Python project', async t => {
  const secretKey = 'KINEX_TEST_CONTEXT_SECRET'
  const previous = process.env[secretKey]
  process.env[secretKey] = 'context-must-not-contain-this-credential'
  t.after(() => { if (previous === undefined) delete process.env[secretKey]; else process.env[secretKey] = previous })
  const { runtime, directory } = await fixture(t)
  const hostProject = '[project]\nname="host-project"\nversion="0.0.0"\n'
  await writeFile(path.join(directory, 'pyproject.toml'), hostProject)
  const before = { ...process.env }
  const status = await runtime.python.status()
  assert.equal(status.env[secretKey], process.env[secretKey])
  const context = await runtime.context()
  assert.equal('env' in context.python, false)
  assert.equal(JSON.stringify(context).includes(process.env[secretKey]), false)
  assert.equal(context.python.executable, status.executable)
  assert.equal(context.python.present, status.present)
  assert.equal(status.project, path.join(directory, '.kinex', 'python'))
  await assert.rejects(readFile(path.join(status.project, 'pyproject.toml')), { code: 'ENOENT' })
  await runtime.python.initialize()
  assert.match(await readFile(path.join(status.project, 'pyproject.toml'), 'utf8'), /numpy/)
  assert.equal(await readFile(path.join(directory, 'pyproject.toml'), 'utf8'), hostProject)
  assert.ok(JSON.stringify(process.env) === JSON.stringify(before), "host environment changed")
  assert.equal((await runtime.python.status()).present, false)
})

test('actuated runtime writes require budgets and return current mock timestamps', async t => {
  const { runtime } = await fixture(t, { host })
  await runtime.profiles.writeDevice({ name: 'arm', type: 'joint', loaded: true,
    access: { connection: { kind: 'mock' } }, intrinsics: {
      model: { format: 'joints', joints: [{ name: 'j0', type: 'revolute', limits: { min: -2, max: 2 }, max_velocity: 2, max_effort: null }] },
      home: null, control: { mode: 'position', speed: null },
      feedback: { velocities: true, efforts: false, clock: 'simulation' },
      stop: { behavior: 'hold', affected_devices: ['arm'] },
    },
  })
  for (const for_s of [undefined, 0, -1, NaN, Infinity]) {
    await assert.rejects(runtime.devices.dispatch('arm', 'write', { target: [0.2], ...(for_s === undefined ? {} : { for_s }) }))
  }
  assert.equal((await runtime.devices.dispatch('arm', 'read')).data.positions[0], 0)
  const written = (await runtime.devices.dispatch('arm', 'write', { target: [0.2], for_s: 0.1 })).data
  const read = (await runtime.devices.dispatch('arm', 'read')).data
  assert.equal(written.elapsed_s, 0.02)
  assert.equal(written.state.sample_time_s, 0.02)
  assert.equal(written.state.sample_time_s, read.sample_time_s)
})

test('drive executes through runtime schema validation and the Python dialog', async t => {
  const { runtime, directory } = await fixture(t, { host })
  await runtime.profiles.writeDevice({ name: 'base', type: 'velocity', loaded: true,
    access: { connection: { kind: 'mock' } }, intrinsics: {
      control: { mode: 'motion', body_frame: 'base', modes: { walk: { posture: null,
        velocity: { frame: 'body', components: [{ axis: 'vx', units: 'm/s', bounds: { min: -1, max: 1 } }] },
      } } },
      feedback: { pose_frame: null, velocity_frame: 'base', velocity_components: ['vx'], clock: 'simulation' },
      stop: { behavior: 'halt', affected_devices: ['base'] },
    },
  })
  // Use the host interpreter explicitly: this test must not prepare core Python.
  const dir = path.join(directory, '.kinex/tool/drive')
  await mkdir(dir, { recursive: true })
  for (const name of ['tool.py', 'tool.yaml']) {
    const source = await readFile(new URL(`../assets/builtin/tool/drive/${name}`, import.meta.url), 'utf8')
    await writeFile(path.join(dir, name), source + (name.endsWith('yaml') ? '\ninterpreter: python3\n' : ''))
  }
  const args = { device: 'base', mode: 'walk', velocity: { vx: 0.2 }, duration_s: 0.1 }
  const response = await runtime.tools.call('drive', args, { sessionID: 's' })
  assert.ok(!response.isError, response.output)
  const result = JSON.parse(response.output)
  assert.equal(result.terminated_by, 'duration')
  assert.ok(Math.abs(result.elapsed_s - 0.1) < 1e-9)
  for (const extra of [{ displacement: { x: 1 } }, { on_timeout: 'continue' }]) {
    const invalid = await runtime.tools.call('drive', { ...args, ...extra }, { sessionID: 's' })
    assert.equal(invalid.isError, true)
  }
  await assert.rejects(runtime.devices.dispatch('base', 'write', { mode: 'walk', velocity: { vx: 0.2 } }))
  await assert.rejects(readFile(path.join(directory, '.kinex/python/pyproject.toml')), { code: 'ENOENT' })
})

test('cancelling track during perception stops its target through the runner', { timeout: 10000 }, async t => {
  const { runtime, directory } = await fixture(t, { host })
  await runtime.profiles.writeDevice({ name: 'arm', type: 'joint', loaded: true,
    access: { connection: { kind: 'mock' } }, intrinsics: {
      model: { format: 'joints', joints: [{ name: 'j0', type: 'revolute', limits: { min: -2, max: 2 }, max_velocity: 2, max_effort: null }] },
      home: null, control: { mode: 'position', speed: null },
      feedback: { velocities: true, efforts: false, clock: 'simulation' },
      stop: { behavior: 'hold', affected_devices: ['arm'] },
    },
  })
  const track = path.join(directory, '.kinex/tool/track')
  await mkdir(track, { recursive: true })
  for (const name of ['tool.py', 'tool.yaml']) {
    const source = await readFile(new URL(`../assets/builtin/tool/track/${name}`, import.meta.url), 'utf8')
    await writeFile(path.join(track, name), source + (name.endsWith('yaml') ? '\ninterpreter: python3\n' : ''))
  }
  const perception = path.join(directory, '.kinex/tool/slow-point')
  await mkdir(perception, { recursive: true })
  await writeFile(path.join(perception, 'tool.yaml'), 'name: slow_point\nkind: perception\ndescription: Test perception delay\ninterpreter: python3\nparameters: {type: object, properties: {}}\ntimeout_s: 30\n')
  await writeFile(path.join(perception, 'tool.py'), 'import time\nfrom kinex import device, finish\ndevice("arm")\ntime.sleep(30)\nfinish({"point": None})\n')
  let started
  const ready = new Promise(resolve => { started = resolve })
  const events = []
  const unsubscribe = runtime.subscribe(({ type, event }) => {
    if (type !== 'device' || event.device.name !== 'arm') return
    events.push(event.action)
    if (event.action === 'read') started()
  })
  t.after(unsubscribe)
  const abort = new AbortController()
  t.after(() => abort.abort())
  const pending = runtime.tools.call('track', {
    perceive: { tool: 'slow_point' }, control: { tool: 'move_to', args: { device: 'arm', timeout_s: 1 } }, timeout_s: 5,
  }, { sessionID: 's', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]) })
  const settled = pending.then(result => ({ result }), error => ({ error }))
  await Promise.race([ready, settled.then(outcome => { throw new Error(`track exited before perception: ${JSON.stringify(outcome)}`) })])
  abort.abort()
  const outcome = await settled
  assert.ok(outcome.error || outcome.result?.isError)
  assert.ok(events.includes('stop'), JSON.stringify(events))
})

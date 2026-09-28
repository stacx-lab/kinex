import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, utimes } from 'node:fs/promises'
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

test('persistent drivers correlate calls, drain stderr, reload and dispose', async t => {
  const { runtime, directory } = await fixture(t, { host })
  await runtime.profiles.writeDevice({ name: 'world', type: 'world', loaded: true, access: { connection: { kind: 'mock' } } })
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
  await runtime.profiles.writeDevice({ name: 'world', type: 'world', loaded: true, access: { connection: { kind: 'mock' } } })
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
  await runtime.profiles.writeDevice({ name: 'world', type: 'world', loaded: true, access: { connection: { kind: 'mock' } } })
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
  await runtime.profiles.writeDevice({ name: 'world', type: 'world', loaded: true, access: { connection: { kind: 'mock' } } })
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
  await runtime.profiles.writeDevice({ name: 'world', type: 'world', loaded: true, access: { connection: { kind: 'mock' } } })
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

test('cancelling a controller before motion does not stop unowned devices', { timeout: 10000 }, async t => {
  const { runtime, directory } = await fixture(t, { host })
  await runtime.profiles.writeDevice({ name: 'world', type: 'world', loaded: true, access: { connection: { kind: 'mock' } } })
  await runtime.profiles.writeDevice({ name: 'arm', type: 'joint', loaded: true,
    access: { connection: { kind: 'mock' } }, intrinsics: {
      model: { format: 'joints', joints: [{ name: 'j0', type: 'revolute', limits: { min: -2, max: 2 }, max_velocity: 2, max_effort: null }] },
      home: null, control: { mode: 'position' },
      feedback: { velocities: true, efforts: false, clock: 'simulation' },
      stop: { behavior: 'hold', affected_devices: ['arm'] },
    },
  })
  const pred = path.join(directory, '.kinex/tool/settled')
  await mkdir(pred, { recursive: true })
  for (const name of ['tool.py', 'tool.yaml']) await writeFile(path.join(pred, name), await readFile(new URL(`../assets/builtin/tool/settled/${name}`, import.meta.url), 'utf8') + (name.endsWith('yaml') ? '\ninterpreter: python3\n' : ''))
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
    perceive: { tool: 'slow_point' }, process: { tool: 'relative_pose', args: { parent: { frame: 'arm' } }, inputs: { '/child': '' } },
    control: { tool: 'servo', args: { device: 'arm', duration_s: 1 } },
    world: 'world', wait_s: .1, until: { tool: 'settled' },
  }, { sessionID: 's', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]) })
  const settled = pending.then(result => ({ result }), error => ({ error }))
  await Promise.race([ready, settled.then(outcome => { throw new Error(`track exited before perception: ${JSON.stringify(outcome)}`) })])
  abort.abort()
  const outcome = await settled
  assert.ok(outcome.error || outcome.result?.isError)
  assert.ok(!events.includes('stop'), JSON.stringify(events))
})

const concurrentDriver = `import threading, time
from kinex.driver_protocol import run, check_cancelled
started = []
release = threading.Event()
active = False
def dispatch(action, args):
    global active
    if action == 'stop' and args.get('fail'):
        return {'ok': False, 'error': 'halt failed'}
    if action == 'write':
        if args['actions'][0][0] == -1:
            return {'ok': False, 'error': 'native halt failed', 'code': 'stop_failed', 'details': {'elapsed_s': .02}}
        active = True
        started.append(args['actions'][0][0])
        release.clear()
        try:
            while not release.wait(.005): check_cancelled()
            check_cancelled()
            return {'ok': True, 'tag': args['actions'][0][0], 'execution_id': 'test', 'elapsed_s': .02, 'state': {'positions': [0], 'velocities': [0], 'efforts': [], 'faults': [], 'sample_time_s': time.monotonic()}}
        finally:
            active = False
    if action == 'read':
        if args.get('release'): release.set()
        if args.get('sleep'): time.sleep(args['sleep'])
    return {'ok': True, 'active': active, 'started': list(started), 'positions': [0], 'velocities': [0], 'efforts': [], 'faults': [], 'sample_time_s': time.monotonic(), **args}
run(dispatch, lambda: None)
`
async function concurrentFixture(t) {
  const value = await fixture(t, { host, enableRecording: true })
  await value.runtime.profiles.writeDevice({ name: 'sensor', type: 'joint', intrinsics: {
    model: { format: 'joints', joints: [{ name: 'j0', type: 'revolute', limits: { min: -2, max: 2 }, max_velocity: 2, max_effort: null }] },
    home: null, control: { mode: 'position' },
    feedback: { velocities: true, efforts: false, clock: 'simulation' },
    stop: { behavior: 'hold', affected_devices: ['sensor'] },
  } })
  await value.runtime.profiles.writeDevice({ name: 'sensor', access: { connection: { kind: 'mock' }, driver: {
    interpreter: 'python3', persistent: true, actions: ['load', 'unload', 'status', 'read', 'write', 'stop'], timeout_s: 3,
  } } })
  const dir = path.join(value.directory, '.kinex', 'devices', 'sensor')
  await writeFile(path.join(dir, 'driver.py'), concurrentDriver)
  await (await value.runtime.devices.load('sensor')).ready
  return value
}
async function waitForRead(runtime, predicate, name = 'sensor') {
  for (let attempt = 0; attempt < 100; attempt++) {
    const reading = await runtime.devices.dispatch(name, 'read', {}, AbortSignal.timeout(1000))
    if (predicate(reading.data)) return reading.data
    await delay(5)
  }
  assert.fail('device did not reach expected state')
}

test('reads and recording continue while a new command replaces the old write', { timeout: 10000 }, async t => {
  const { runtime } = await concurrentFixture(t)
  const samples = []
  runtime.subscribe(event => {
    if (event.type === 'device' && event.event.origin === 'sampler') samples.push(event.event)
  })
  await runtime.recording.start({ specs: { sensor: { rate: 50 } }, sessionID: 'concurrency' })
  const first = runtime.devices.dispatch('sensor', 'write', { actions: [[1]], duration_s: .02 })
  const interrupted = assert.rejects(first, /interrupted|replaced/)
  await waitForRead(runtime, state => state.active)
  const second = runtime.devices.dispatch('sensor', 'write', { actions: [[2]], duration_s: .02 })
  await interrupted
  await waitForRead(runtime, state => state.started.length === 2)
  const until = Date.now() + 1500
  while (samples.filter(event => event.reading?.data?.active).length < 3 && Date.now() < until) await delay(10)
  assert.ok(samples.filter(event => event.reading?.data?.active).length >= 3)
  await runtime.devices.dispatch('sensor', 'read', { release: true })
  assert.equal((await second).data.tag, 2)
  await runtime.recording.stop()
})

test('persistent responses can finish out of order without swapping callers', async t => {
  const { runtime } = await concurrentFixture(t)
  const order = []
  const slow = runtime.devices.dispatch('sensor', 'read', { tag: 'slow', sleep: .2 }).then(value => { order.push('slow'); return value })
  const fast = runtime.devices.dispatch('sensor', 'read', { tag: 'fast' }).then(value => { order.push('fast'); return value })
  assert.equal((await fast).data.tag, 'fast')
  assert.equal((await slow).data.tag, 'slow')
  assert.deepEqual(order, ['fast', 'slow'])
})

test('stop interrupts active motion and allows a subsequent write', { timeout: 5000 }, async t => {
  const { runtime } = await concurrentFixture(t)
  const active = runtime.devices.dispatch('sensor', 'write', { actions: [[1]], duration_s: .02 })
  const activeRejected = assert.rejects(active, /interrupt/i)
  await waitForRead(runtime, state => state.active)
  await runtime.devices.dispatch('sensor', 'stop')
  await activeRejected
  assert.deepEqual((await runtime.devices.dispatch('sensor', 'read')).data.started, [1])
  const next = runtime.devices.dispatch('sensor', 'write', { actions: [[2]], duration_s: .02 })
  await waitForRead(runtime, state => state.started.length === 2)
  await runtime.devices.dispatch('sensor', 'read', { release: true })
  assert.equal((await next).data.tag, 2)
})

test('unload interrupts motion and fences active reads before releasing the driver', { timeout: 5000 }, async t => {
  const { runtime } = await concurrentFixture(t)
  const active = runtime.devices.dispatch('sensor', 'write', { actions: [[1]], duration_s: .02 })
  const rejected = assert.rejects(active, /interrupt/i)
  await waitForRead(runtime, state => state.active)
  const read = runtime.devices.dispatch('sensor', 'read', { sleep: .1 })
  await delay(20)
  await runtime.devices.unload('sensor')
  await read
  await rejected
  await assert.rejects(runtime.devices.dispatch('sensor', 'read'), /not loaded|inactive/)
  await (await runtime.devices.load('sensor')).ready
  assert.deepEqual((await runtime.devices.dispatch('sensor', 'read')).data.started, [])
})

test('a scoped stop cancels cooperative writes in every affected persistent driver', { timeout: 5000 }, async t => {
  const { runtime, directory } = await concurrentFixture(t)
  const profile = (await runtime.devices.list()).find(device => device.name === 'sensor')
  await runtime.profiles.writeDevice({ ...profile, name: 'peer', intrinsics: { ...profile.intrinsics, stop: { behavior: 'hold', affected_devices: ['peer'] } } })
  await writeFile(path.join(directory, '.kinex', 'devices', 'peer', 'driver.py'), concurrentDriver)
  await (await runtime.devices.load('peer')).ready
  await runtime.profiles.writeDevice({ name: 'sensor', intrinsics: { stop: { behavior: 'hold', affected_devices: ['sensor', 'peer'] } } })
  const active = runtime.devices.dispatch('peer', 'write', { actions: [[1]], duration_s: .02 })
  const rejected = assert.rejects(active, /interrupt/i)
  await waitForRead(runtime, state => state.active, 'peer')
  await runtime.devices.dispatch('sensor', 'stop')
  await rejected
  assert.equal((await runtime.devices.dispatch('peer', 'read')).data.active, false)
})

test('failed stop leaves reads available and fences writes until reload', async t => {
  const { runtime } = await concurrentFixture(t)
  await assert.rejects(runtime.devices.dispatch('sensor', 'stop', { fail: true }), /halt failed/)
  assert.ok((await runtime.devices.dispatch('sensor', 'read')).data)
  await assert.rejects(runtime.devices.dispatch('sensor', 'write', { actions: [[1]], duration_s: .02 }), /stop failed|reload/i)
  await (await runtime.devices.reload('sensor')).ready
  const next = runtime.devices.dispatch('sensor', 'write', { actions: [[1]], duration_s: .02 })
  await waitForRead(runtime, state => state.active)
  await runtime.devices.dispatch('sensor', 'read', { release: true })
  await next
})

test('untagged persistent replies fail explicitly without a legacy fallback', async t => {
  const { runtime, directory } = await fixture(t, { host })
  await runtime.profiles.writeDevice({ name: 'world', type: 'world', loaded: true, access: { connection: { kind: 'mock' } } })
  const dir = await pythonDriver(runtime, directory)
  await writeFile(path.join(dir, 'driver.py'), 'import sys, json\nfor line in sys.stdin:\n print(json.dumps({"ok": True}), flush=True)\n')
  const activation = await runtime.devices.load('sensor')
  await assert.rejects(activation.ready, /echo request id.*migrate/i)
  await assert.rejects(runtime.devices.dispatch('sensor', 'read'), /inactive/i)
})

test('stop terminates an active one-shot command before admitting another write', { timeout: 5000 }, async t => {
  const { runtime, directory } = await concurrentFixture(t)
  await runtime.devices.unload('sensor')
  await runtime.profiles.writeDevice({ name: 'sensor', access: { driver: { persistent: false } } })
  const dir = path.join(directory, '.kinex/devices/sensor')
  await writeFile(path.join(dir, 'driver.py'), `import os, time
from pathlib import Path
from kinex.driver_protocol import run
def dispatch(action, args):
    if action == 'write':
        Path('writing').write_text(str(os.getpid()))
        time.sleep(30)
        Path('late-write').write_text('unsafe')
    return {'ok': True}
run(dispatch, lambda: None)
`)
  await (await runtime.devices.load('sensor')).ready
  const active = runtime.devices.dispatch('sensor', 'write', { actions: [[1]], duration_s: .02 })
  const rejected = assert.rejects(active, /interrupted/)
  let pid
  const deadline = Date.now() + 2000
  while (!pid && Date.now() < deadline) {
    pid = await readFile(path.join(dir, 'writing'), 'utf8').catch(() => undefined)
    if (!pid) await delay(5)
  }
  assert.ok(pid)
  await runtime.devices.dispatch('sensor', 'stop')
  await rejected
  assert.throws(() => process.kill(Number(pid), 0), { code: 'ESRCH' })
  await assert.rejects(readFile(path.join(dir, 'late-write')), { code: 'ENOENT' })
})

test('joint buffers validate before execution and accept arbitrary rates', async t => {
  const { runtime } = await fixture(t, { host })
  await runtime.profiles.writeDevice({ name: 'arm', type: 'joint', loaded: true,
    access: { connection: { kind: 'mock' } }, intrinsics: {
      model: { format: 'joints', joints: [{ name: 'j0', type: 'revolute', limits: { min: -2, max: 2 }, max_velocity: 2, max_effort: null }] },
      home: null, control: { mode: 'position' },
      feedback: { velocities: true, efforts: false, clock: 'simulation' },
      stop: { behavior: 'hold', affected_devices: ['arm'] },
    },
  })
  for (const args of [
    { actions: [], duration_s: .02 }, { actions: [[0.1], [3]], duration_s: .02 },
    { actions: [[0.1]], duration_s: 1, block_s: 0 },
    { actions: [[0.1]], freq_hz: 0 }, { target: [0.1], for_s: 1 },
  ]) await assert.rejects(runtime.devices.dispatch('arm', 'write', args))
  assert.equal((await runtime.devices.dispatch('arm', 'read')).data.sample_time_s, 0)
  await runtime.profiles.writeDevice({ name: 'world', type: 'world', loaded: true, access: { connection: { kind: 'mock' } } })
  const sequence = (await runtime.devices.dispatch('arm', 'write', { actions: [[0.1], [0.2]], duration_s: .08 })).data
  assert.equal(sequence.elapsed_s, 0)
  assert.deepEqual(sequence.state.positions, [0])
  await runtime.devices.dispatch('world', 'wait', { duration_s: .08 })
  assert.deepEqual((await runtime.devices.dispatch('arm', 'read')).data.positions, [.2])
  await runtime.devices.dispatch('arm', 'write', { actions: [[.1]], duration_s: 1 })
  await assert.rejects(runtime.devices.dispatch('arm', 'write', { actions: [[99]], duration_s: 1 }))
  await runtime.devices.dispatch('world', 'wait', { duration_s: 1 })
  assert.deepEqual((await runtime.devices.dispatch('arm', 'read')).data.positions, [.1])
})

test('native motion stop failures preserve progress and fence subsequent commands', async t => {
  const { runtime } = await concurrentFixture(t)
  await assert.rejects(runtime.devices.dispatch('sensor', 'write', { actions: [[-1]], duration_s: .02 }),
    error => error.data.code === 'stop_failed' && error.data.details.elapsed_s === .02)
  await assert.rejects(runtime.devices.dispatch('sensor', 'write', { actions: [[1]], duration_s: .02 }), /stop failed/)
  assert.deepEqual((await runtime.devices.dispatch('sensor', 'read')).data.started, [])
})


test('servo submits through the runtime and world.wait executes its buffer', async t => {
  const { runtime, directory } = await fixture(t, { host })
  await runtime.profiles.writeDevice({ name: 'world', type: 'world', loaded: true, access: { connection: { kind: 'mock' } } })
  await runtime.profiles.writeDevice({ name: 'arm', type: 'joint', loaded: true,
    access: { connection: { kind: 'mock' } }, intrinsics: {
      model: { format: 'joints', joints: [{ name: 'j0', type: 'revolute', limits: { min: -2, max: 2 }, max_velocity: 1, max_acceleration: 2, max_effort: null }] },
      home: null, control: { mode: 'position' },
      feedback: { velocities: true, efforts: false, clock: 'simulation' },
      stop: { behavior: 'hold', affected_devices: ['arm'] },
    },
  })
  const dir = path.join(directory, '.kinex/tool/servo')
  await mkdir(dir, { recursive: true })
  for (const name of ['tool.py', 'tool.yaml']) {
    const source = await readFile(new URL(`../assets/builtin/tool/servo/${name}`, import.meta.url), 'utf8')
    await writeFile(path.join(dir, name), source + (name.endsWith('yaml') ? '\ninterpreter: python3\n' : ''))
  }
  const response = await runtime.tools.call('servo', { device: 'arm', joints: [.2], duration_s: 3 }, { sessionID: 's' })
  assert.ok(!response.isError, response.output)
  const result = JSON.parse(response.output)
  assert.deepEqual(result.joints, [.2])
  assert.deepEqual((await runtime.devices.dispatch('arm', 'read')).data.positions, [0])
  await runtime.devices.dispatch('world', 'wait', { duration_s: 3 })
  assert.deepEqual((await runtime.devices.dispatch('arm', 'read')).data.positions, [.2])
})

async function trackingFixture(t) {
  const value = await fixture(t, { host })
  const { runtime, directory } = value
  await runtime.profiles.writeDevice({ name: 'world', type: 'world', loaded: true, access: { connection: { kind: 'mock' } } })
  for (const name of ['arm', 'hand', 'unrelated']) {
    await runtime.profiles.writeDevice({ name, type: 'joint', loaded: true,
      access: { connection: { kind: 'mock' } }, intrinsics: {
        model: { format: 'joints', joints: [{ name: 'j0', type: 'revolute', limits: { min: -2, max: 2 }, max_velocity: 2, max_effort: null }] },
        home: null, control: { mode: 'position' },
        feedback: { velocities: true, efforts: false, clock: 'simulation' },
        stop: { behavior: 'hold', affected_devices: [name] },
      },
    })
  }
  const install = async (name, manifest, code) => {
    const dir = path.join(directory, '.kinex/tool', name)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'tool.yaml'), `${manifest}\ninterpreter: python3\n`)
    await writeFile(path.join(dir, 'tool.py'), code)
  }
  await install('track', await readFile(new URL('../assets/builtin/tool/track/tool.yaml', import.meta.url), 'utf8'),
    await readFile(new URL('../assets/builtin/tool/track/tool.py', import.meta.url), 'utf8'))
  await install('sample', 'name: sample\nkind: perception\ndescription: test',
    'from kinex import device, finish\nfinish(device("arm")["data"])\n')
  await install('convert', 'name: convert\nkind: perception\ndescription: test\nparameters: {type: object}', `import time
from kinex import args, device, call, stop_owned, finish
from kinex.control import read
a = args()
mode = a.get('mode')
if mode == 'stop': stop_owned()
if mode == 'write': device('arm', 'write', actions=[[.2]], duration_s=.1)
if mode == 'compose': call('act', target=.2)
if mode == 'invalid': finish({'target': 'invalid'})
if mode == 'model': device('policy', 'infer')
if a['observation']['positions'][0] > 0:
    if mode == 'wait':
        device('sensor')
        time.sleep(30)
    if mode == 'fail': raise RuntimeError('processing failed after motion')
    finish(None)
finish({'target': .2})
`)
  await install('act', `name: act
kind: controller
description: test
parameters:
  type: object
  additionalProperties: false
  properties:
    target: {type: number}
  required: [target]`, `from kinex import args, devices, finish
results = devices([{'device': name, 'action': 'write', 'args': {'actions': [[args()['target']]], 'duration_s': .1}} for name in ['arm', 'hand']])
if not all(r['ok'] for r in results): raise RuntimeError(str(results))
finish({'custom': True})
`)
  const events = []
  t.after(runtime.subscribe(({ type, event }) => { if (type === 'device') events.push(event) }))
  await install('never', 'name: never\nkind: perception\ndescription: predicate\nparameters: {type: object}', 'from kinex import finish\nfinish({"done": False})\n')
  const args = { world: 'world', wait_s: .1, until: { tool: 'never' }, perceive: { tool: 'sample' }, process: { tool: 'convert' }, control: { tool: 'act' }, max_misses: 1 }
  return { ...value, args, events }
}

test('track stops owned actuators on misses and errors, excluding model inference and unrelated motion', async t => {
  for (const mode of ['model', 'fail']) {
    await t.test(mode, async t => {
      const { runtime, directory, args, events } = await trackingFixture(t)
      const contract = { type: 'object', properties: {}, required: [] }
      await runtime.profiles.writeDevice({ name: 'policy', type: 'model', loaded: true,
        access: { connection: { kind: 'process', compute: { kind: 'cpu' } }, driver: { interpreter: 'python3', actions: ['read', 'status', 'load', 'unload', 'infer'], timeout_s: 5 } },
        intrinsics: { family: 'test', artifacts: [], operations: [{ name: 'infer', input: contract, output: contract }] },
      })
      await writeFile(path.join(directory, '.kinex/devices/policy/driver.py'),
        'from kinex.driver_protocol import run\nrun(lambda action, args: {"ok": True}, lambda: None)\n')
      await (await runtime.devices.load('policy')).ready
      await runtime.devices.dispatch('unrelated', 'write', { actions: [[.5]], duration_s: .1 })
      const response = await runtime.tools.call('track', { ...args, process: { tool: 'convert', args: { mode } } }, { sessionID: 's' })
      if (mode === 'fail') {
        assert.equal(response.isError, true)
        assert.match(response.output, /processing failed after motion/)
      } else {
        assert.ok(!response.isError, response.output)
        assert.equal(JSON.parse(response.output).terminated_by, 'perception_lost')
        assert.equal(events.filter(e => e.action === 'infer').length, 2)
      }
      assert.deepEqual([...new Set(events.filter(e => e.action === 'stop').map(e => e.device.name))].sort(), ['arm', 'hand'])
      assert.equal((await runtime.devices.dispatch('unrelated', 'read')).data.stopped, false)
      for (const name of ['arm', 'hand']) assert.equal((await runtime.devices.dispatch(name, 'read')).data.stopped, true)
    })
  }
})

test('processing retains perception permissions and generated controller arguments are validated', async t => {
  const { runtime, args, events } = await trackingFixture(t)
  for (const [mode, error] of [['stop', /only controller tools/], ['write', /may not command/], ['compose', /may only compose/], ['invalid', /target/]]) {
    const response = await runtime.tools.call('track', { ...args, process: { tool: 'convert', args: { mode } } }, { sessionID: 's' })
    assert.equal(response.isError, true, mode)
    assert.match(response.output, error)
  }
  assert.ok(!events.some(e => e.action === 'write' || e.action === 'stop'))
})

test('cancelling track during processing stops owned motion without stopping its replacement', { timeout: 15000 }, async t => {
  const { runtime, args, events } = await trackingFixture(t)
  let started
  const ready = new Promise(resolve => { started = resolve })
  t.after(runtime.subscribe(({ type, event }) => {
    if (type === 'device' && event.device.name === 'sensor' && event.action === 'read') started()
  }))
  const abort = new AbortController()
  t.after(() => abort.abort())
  const pending = runtime.tools.call('track', { ...args, process: { tool: 'convert', args: { mode: 'wait' } } },
    { sessionID: 's', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]) })
  await Promise.race([ready, pending.then(response => { throw Error(`track exited before processing wait: ${response.output}`) })])
  await runtime.devices.dispatch('arm', 'write', { actions: [[.8]], duration_s: .1 })
  abort.abort()
  assert.equal((await pending).isError, true)
  assert.deepEqual([...new Set(events.filter(e => e.action === 'stop').map(e => e.device.name))], ['hand'])
  assert.equal((await runtime.devices.dispatch('arm', 'read')).data.stopped, false)
  assert.equal((await runtime.devices.dispatch('hand', 'read')).data.stopped, true)
})

test('cancelling one world wait leaves concurrent waits and the driver usable', async t => {
  const { runtime, directory } = await fixture(t)
  await runtime.profiles.writeDevice({ name: 'world', type: 'world', loaded: false,
    access: { connection: { kind: 'process' }, driver: {
      interpreter: 'python3', persistent: true, actions: ['read', 'wait', 'load', 'unload', 'status'],
    } } })
  await writeFile(path.join(directory, '.kinex/devices/world/driver.py'),
    await readFile(new URL('../assets/builtin/device/templates/world/driver.py', import.meta.url)))
  await (await runtime.devices.load('world')).ready
  const cancelled = new AbortController()
  const long = runtime.devices.dispatch('world', 'wait', { duration_s: 5 }, cancelled.signal)
  const rejected = assert.rejects(long)
  const short = runtime.devices.dispatch('world', 'wait', { duration_s: .2 })
  await delay(50)
  cancelled.abort(new Error('cancel this wait'))
  await rejected
  assert.ok((await short).data.elapsed_s >= .2)
  const now = (await runtime.devices.dispatch('world', 'read')).data.time_s
  assert.ok(Number.isFinite(now))
  assert.ok((await runtime.devices.dispatch('world', 'wait', { duration_s: .01 })).data.time_s > now)
})

test('end-effectors require flat actions and reject invalid replacements before effects', async t => {
  const { runtime } = await fixture(t)
  await runtime.profiles.writeDevice({ name: 'world', type: 'world', loaded: true, access: { connection: { kind: 'mock' } } })
  for (const [type, control, actions, invalid] of [
    ['gripper', { mode: 'position', units: 'normalized', bounds: { min: 0, max: 1 }, resolution: null, open_target: 0, close_target: 1, speed: null }, [.2, .8], 2],
    ['suction', { mode: 'binary', off_target: 2, on_target: 5 }, [2, 5], 3],
  ]) {
    await runtime.profiles.writeDevice({ name: type, type, loaded: true, access: { connection: { kind: 'mock' } },
      intrinsics: { control, feedback: { positions: [], velocities: false, clock: 'simulation' },
        stop: { behavior: 'hold', affected_devices: [type] } },
    })
    const write = values => runtime.devices.dispatch(type, 'write', { duration_s: .2, ...values })
    const accepted = await write({ actions })
    assert.ok(accepted.data.execution_id)
    for (const values of [{ target: [actions[0]] }, { actions: [[actions[0]]] }, { actions: [] },
      { actions: [true] }, { actions: [NaN] }, { actions: [actions[0], invalid] }, { actions, speedFraction: .5 }]) {
      await assert.rejects(write(values))
    }
    await runtime.devices.dispatch('world', 'wait', { duration_s: .2 })
    assert.deepEqual((await runtime.devices.dispatch(type, 'read')).data.positions, [actions.at(-1)])
    await write({ actions: [actions[0]] })
    await runtime.devices.dispatch('world', 'wait', { duration_s: .2 })
    const state = (await runtime.devices.dispatch(type, 'read')).data
    assert.deepEqual(state.positions, [actions[0]])
    assert.equal(state.stopped, false)
  }
})

test('devices preauthorizes concurrent reads, preserves partial results and attaches images', async t => {
  const permissions = [], events = []
  const { runtime, directory } = await fixture(t, { host: { ask: async request => {
    assert.equal(events.length, 0, 'authorization precedes every device effect')
    permissions.push(request.permission)
  } } })
  const dir = await pythonDriver(runtime, directory)
  const file = path.join(dir, 'frame.png')
  await writeFile(file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64'))
  await writeFile(path.join(dir, 'driver.py'), `import threading
from kinex.driver_protocol import run
barrier = threading.Barrier(2)
def dispatch(action, args):
    if args.get('batch'):
        barrier.wait(2)
    return {'ok': True, **args}
run(dispatch, lambda: None)
`)
  await (await runtime.devices.load('sensor')).ready
  t.after(runtime.subscribe(({ type, event }) => { if (type === 'device') events.push(event) }))
  const result = await runtime.tools.call('devices', { calls: [
    { deviceID: 'sensor', args: { batch: true, index: 0, file } },
    { deviceID: 'missing' },
    { deviceID: 'sensor', args: { batch: true, index: 2 } },
  ] }, { sessionID: 's' })
  assert.equal(result.isError, true)
  const rows = JSON.parse(result.output).results
  assert.deepEqual(rows.map(row => [row.deviceID, row.action, row.ok]), [['sensor', 'read', true], ['missing', 'read', false], ['sensor', 'read', true]])
  assert.equal(rows[0].data.index, 0)
  assert.equal(rows[2].data.index, 2)
  assert.equal(rows[0].file, file)
  assert.deepEqual(result.attachments, [{ mime: 'image/png', path: file }])
  assert.deepEqual(permissions, ['device_read', 'device_read'])
  assert.equal(events.length, 2)
})

test('devices denial dispatches nothing and cancellation interrupts a pending batch', async t => {
  let requests = 0, deny = true
  const { runtime, directory } = await fixture(t, { host: { ask: async () => {
    if (deny && ++requests === 2) throw new PermissionDeniedError('device_read')
  } } })
  await pythonDriver(runtime, directory)
  await (await runtime.devices.load('sensor')).ready
  const events = []
  t.after(runtime.subscribe(({ type, event }) => { if (type === 'device') events.push(event) }))
  await assert.rejects(runtime.tools.call('devices', { calls: [{ deviceID: 'sensor' }, { deviceID: 'sensor' }] }, { sessionID: 's' }), PermissionDeniedError)
  assert.equal(events.length, 0)
  deny = false
  const result = await runtime.tools.call('devices', { calls: [{ deviceID: 'sensor', args: { sleep: 30 } }] }, { sessionID: 's', signal: AbortSignal.timeout(200) })
  assert.equal(result.isError, true)
  assert.match(result.output, /abort|timeout/i)
})

test('Python composes device tools without gaining lifecycle or motion capabilities', async t => {
  const { runtime, directory } = await trackingFixture(t)
  const dir = path.join(directory, '.kinex/tool/probe')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'tool.yaml'), 'name: probe\nkind: perception\ndescription: test\ninterpreter: python3\nparameters: {type: object}\n')
  await writeFile(path.join(dir, 'tool.py'), 'from kinex import args, call, finish\na = args()\nfinish(call(a["tool"], **a["args"]))\n')
  const events = []
  t.after(runtime.subscribe(({ type, event }) => { if (type === 'device') events.push(event) }))
  const call = (tool, args) => runtime.tools.call('probe', { tool, args }, { sessionID: 's' })
  for (const action of ['load', 'unload', 'write']) {
    const single = await call('device', { deviceID: 'arm', action })
    assert.equal(single.isError, true)
    assert.match(single.output, action === 'write' ? /may not command/ : /inside Python/)
    const batch = await call('devices', { calls: [{ deviceID: 'arm', action }] })
    assert.equal(JSON.parse(batch.output).results[0].ok, false)
  }
  assert.equal(events.length, 0)
  const read = await call('devices', { calls: [{ deviceID: 'arm' }] })
  assert.equal(JSON.parse(read.output).results[0].ok, true)
  assert.equal(events.length, 1)
})

test('track consumes devices results through nested input mappings', async t => {
  const { runtime, directory, args } = await trackingFixture(t)
  const dir = path.join(directory, '.kinex/tool/extract')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'tool.yaml'), 'name: extract\nkind: perception\ndescription: test\ninterpreter: python3\nparameters: {type: object}\n')
  await writeFile(path.join(dir, 'tool.py'), 'from kinex import args, finish\nassert args()["position"] == 0\nfinish({"goal": .2, "unused": True})\n')
  const result = await runtime.tools.call('track', { ...args, max_rounds: 1,
    perceive: { tool: 'devices', args: { calls: [{ deviceID: 'arm' }] } },
    process: { tool: 'extract', inputs: { '/position': '/results/0/data/positions/0' } },
    control: { tool: 'act', inputs: { '/target': '/goal' } },
  }, { sessionID: 's' })
  assert.ok(!result.isError, result.output)
  assert.equal(JSON.parse(result.output).rounds, 1)
  for (const name of ['arm', 'hand']) assert.equal((await runtime.devices.dispatch(name, 'read')).data.stopped, true)
})

test('track executes inline stages immediately with mappings, fresh globals and predicate state', async t => {
  const { runtime, directory, args, events } = await trackingFixture(t)
  const track = path.join(directory, '.kinex/tool/track')
  await writeFile(path.join(track, 'offset.json'), '0.1')
  const files = await readdir(path.join(directory, '.kinex/tool'), { recursive: true })
  const result = await runtime.tools.call('track', { ...args,
    perceive: { python: 'lambda target: {"measured": target}', args: { target: .1 } },
    process: {
      python: `import json
from pathlib import Path
count = 0
def convert(value):
    return value + json.loads(Path('offset.json').read_text())
def main(measurement, unused):
    global count
    count += 1
    assert count == 1
    print('processing observation')
    return {'goal': convert(measurement)}
`,
      args: { unused: true, measurement: 99 }, inputs: { '/measurement': '/measured' },
    },
    control: { tool: 'act', args: { target: 99 }, inputs: { '/target': '/goal' } },
    until: { python: `def main(context, state, rounds):
    checks = (state or 0) + 1
    assert checks == context['round'] + 1
    if context['round']:
        assert context['observation'] == {'measured': 0.1}
        assert context['control_args'] == {'target': 0.2}
        assert context['control_result'] == {'custom': True}
    return {'done': context['round'] >= rounds, 'state': checks, 'reason': 'target'}
`, args: { rounds: 2 } },
  }, { sessionID: 's' })
  assert.ok(!result.isError, result.output)
  assert.deepEqual(JSON.parse(result.output), {
    terminated_by: 'target', rounds: 2, perception_misses: 0, last: { custom: true }, until_state: 3,
  })
  assert.equal(events.filter(e => e.action === 'wait').length, 2)
  assert.deepEqual(await readdir(path.join(directory, '.kinex/tool'), { recursive: true }), files)
  for (const name of ['arm', 'hand']) assert.equal((await runtime.devices.dispatch(name, 'read')).data.stopped, true)
})

test('inline control composes tools and preserves owned cleanup on nulls and failures', async t => {
  const { runtime, args, events } = await trackingFixture(t)
  for (const failure of [false, true]) {
    events.length = 0
    const result = await runtime.tools.call('track', { ...args,
      process: { python: `def main(observation, failure):
    if observation['positions'][0] > 0:
        if failure:
            raise ValueError('inline processing failed')
        return None
    return {'target': 0.2}
`, args: { failure } },
      control: { python: `from kinex import call
def main(target):
    return call('act', target=target)
` },
    }, { sessionID: 's' })
    if (failure) {
      assert.equal(result.isError, true)
      assert.match(result.output, /inline processing failed/)
    } else {
      assert.ok(!result.isError, result.output)
      assert.equal(JSON.parse(result.output).terminated_by, 'perception_lost')
    }
    assert.deepEqual([...new Set(events.filter(e => e.action === 'stop').map(e => e.device.name))].sort(), ['arm', 'hand'])
    for (const name of ['arm', 'hand']) {
      assert.equal((await runtime.devices.dispatch(name, 'read')).data.stopped, true)
      await runtime.devices.dispatch(name, 'write', { actions: [[0]], duration_s: .1 })
    }
    await runtime.devices.dispatch('world', 'wait', { duration_s: .1 })
  }
})

test('inline perception cannot acquire controller or lifecycle capabilities', async t => {
  const { runtime, args, events } = await trackingFixture(t)
  const cases = [
    ['perceive', 'device("arm", "write", actions=[[.2]], duration_s=.1)', /may not command/],
    ['process', 'stop_owned()', /only controller tools/],
    ['until', 'call("act", target=.2)', /may only compose/],
    ['process', 'inline("lambda: None", {}, kind="controller")', /may only compose/],
    ['process', 'device("arm", "unload")', /inside Python/],
    ['control', 'device("arm", "unload")', /inside Python/],
  ]
  for (const [stage, expression, error] of cases) {
    const result = await runtime.tools.call('track', { ...args,
      [stage]: { python: `from kinex import device, call, inline, stop_owned\ndef main(**kwargs):\n    return ${expression}\n` },
    }, { sessionID: 's' })
    assert.equal(result.isError, true, expression)
    assert.match(result.output, error)
  }
  assert.ok(!events.some(e => ['write', 'stop', 'unload'].includes(e.action)))
})

test('inline definition and return errors are visible without dispatching control', async t => {
  const { runtime, args, events } = await trackingFixture(t)
  for (const [python, error] of [
    ['lambda observation:', /SyntaxError/],
    ['value = 1', /must be a lambda or define main/],
    ['lambda observation: {1, 2}', /not JSON serializable/],
    ['lambda missing: {}', /unexpected keyword argument/],
    ['lambda observation: []', /process must return a dict/],
  ]) {
    const result = await runtime.tools.call('track', { ...args, process: { python } }, { sessionID: 's' })
    assert.equal(result.isError, true)
    assert.match(result.output, error)
  }
  for (const process of [{}, { python: '' }, { tool: 'convert', python: 'lambda observation: {}' }, { python: 'lambda observation: {}', extra: true }]) {
    const result = await runtime.tools.call('track', { ...args, process }, { sessionID: 's' })
    assert.equal(result.isError, true)
  }
  assert.ok(!events.some(e => e.action === 'write'))
})

test('inline execution inherits cancellation and the track deadline', { timeout: 20000 }, async t => {
  for (const mode of ['cancel', 'timeout']) await t.test(mode, async t => {
    const { runtime, directory, args, events } = await trackingFixture(t)
    if (mode === 'timeout') {
      const manifest = path.join(directory, '.kinex/tool/track/tool.yaml')
      await writeFile(manifest, (await readFile(manifest, 'utf8')).replace('timeout_s: 900', 'timeout_s: 5'))
    }
    let started
    const ready = new Promise(resolve => { started = resolve })
    t.after(runtime.subscribe(({ type, event }) => {
      if (type === 'device' && event.device.name === 'sensor' && event.action === 'read') started()
    }))
    const abort = new AbortController()
    t.after(() => abort.abort())
    const pending = runtime.tools.call('track', { ...args,
      process: { python: `import time
from kinex import device
def main(observation):
    if observation['positions'][0] > 0:
        device('sensor')
        time.sleep(30)
    return {'target': 0.2}
` },
    }, { sessionID: 's', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(12000)]) })
    await Promise.race([ready, pending.then(response => { throw Error(`track exited before inline wait: ${response.output}`) })])
    await runtime.devices.dispatch('arm', 'write', { actions: [[.8]], duration_s: .1 })
    if (mode === 'cancel') abort.abort()
    const response = await pending
    assert.equal(response.isError, true)
    assert.match(response.output, /abort|interrupt|timed out|timeout/i)
    assert.deepEqual([...new Set(events.filter(e => e.action === 'stop').map(e => e.device.name))], ['hand'])
    assert.equal((await runtime.devices.dispatch('arm', 'read')).data.stopped, false)
    assert.equal((await runtime.devices.dispatch('hand', 'read')).data.stopped, true)
  })
})

test('nested Python device composition preserves permission denial as a host error', async t => {
  const { runtime, directory } = await fixture(t, { host: { ask: async ({ permission }) => {
    if (permission === 'device_read') throw new PermissionDeniedError(permission)
  } } })
  await pythonDriver(runtime, directory)
  await (await runtime.devices.load('sensor')).ready
  const inline = 'from kinex import call\ndef main():\n    return call("device", deviceID="sensor")\n'
  for (const [name, body] of [
    ['inner', 'finish(call("device", deviceID="sensor"))'], ['outer', 'finish(call("inner"))'],
    ['inline_outer', `finish(inline(${JSON.stringify(inline)}, {}))`],
  ]) {
    const dir = path.join(directory, '.kinex/tool', name)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'tool.yaml'), `name: ${name}\nkind: perception\ndescription: test\ninterpreter: python3\n`)
    await writeFile(path.join(dir, 'tool.py'), `from kinex import call, finish, inline\n${body}\n`)
  }
  const events = []
  t.after(runtime.subscribe(({ type, event }) => { if (type === 'device') events.push(event) }))
  for (const name of ['outer', 'inline_outer'])
    await assert.rejects(runtime.tools.call(name, {}, { sessionID: 's' }), PermissionDeniedError)
  assert.equal(events.length, 0)
})

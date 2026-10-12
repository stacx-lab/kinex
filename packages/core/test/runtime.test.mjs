import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, utimes } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createHash } from 'node:crypto'
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

async function pythonTool(directory, name, code, kind = 'perception', timeout = 10) {
  const dir = path.join(directory, '.kinex/tool', name)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'tool.yaml'), `name: ${name}\nkind: ${kind}\ndescription: test\ninterpreter: python3\ntimeout_s: ${timeout}\nparameters: {type: object}\n`)
  await writeFile(path.join(dir, 'tool.py'), code)
  return dir
}

test('Python startup carries large Unicode arguments and inline source through nested calls', async t => {
  const { runtime, directory } = await fixture(t, { host })
  await pythonTool(directory, 'digest', `import hashlib, os, subprocess, sys
from kinex import args, finish, robot
robot()  # Must not consume the startup request as an RPC response.
a = args()
assert args() == a
assert len(sys.argv) == 1
assert 'KINEX_TOOL_DIALOG' not in os.environ
child = subprocess.run([sys.executable, '-c', 'import kinex; print("ordinary import")'], capture_output=True, text=True, check=True)
assert child.stdout.strip() == 'ordinary import'
finish({'length': len(a['value']), 'sha256': hashlib.sha256(a['value'].encode()).hexdigest()})
`)
  await pythonTool(directory, 'nested', `from kinex import args, inline, finish
a = args()
finish(inline(a['source'], {'value': a['value']}))
`)
  const source = `# ${'large source '.repeat(15000)}\nfrom kinex import call\ndef main(value):\n    return call('digest', value=value)\n`
  for (const value of ['small', 'x'.repeat(3 * 1024 * 1024), '🦾画像'.repeat(100000)]) {
    for (const name of ['digest', 'nested']) {
      const response = await runtime.tools.call(name, name === 'nested' ? { value, source } : { value }, { sessionID: 's' })
      assert.ok(!response.isError, response.output)
      assert.deepEqual(JSON.parse(response.output), {
        length: [...value].length, sha256: createHash('sha256').update(value).digest('hex'),
      })
    }
  }
})

test('one-shot drivers accept large requests, receive EOF and release resources', async t => {
  const { runtime, directory } = await fixture(t, { host })
  const dir = await pythonDriver(runtime, directory, false)
  await writeFile(path.join(dir, 'driver.py'), `import hashlib, sys
from kinex.driver_protocol import run
def dispatch(action, args):
    assert len(sys.argv) == 1
    assert sys.stdin.read() == ''
    return {'ok': True, 'sha256': hashlib.sha256(args['value'].encode()).hexdigest()}
def cleanup():
    with open('closed', 'a') as output: output.write('closed\\n')
run(dispatch, cleanup)
`)
  for (const value of ['small', 'x'.repeat(3 * 1024 * 1024), '🦾画像'.repeat(100000)]) {
    const result = await runtime.devices.dispatch('sensor', 'read', { value })
    assert.equal(result.data.sha256, createHash('sha256').update(value).digest('hex'))
  }
  assert.equal((await readFile(path.join(dir, 'closed'), 'utf8')).trim().split('\n').length, 3)
})

test('large startup writes tolerate noisy tools and report early exit', async t => {
  const { runtime, directory } = await fixture(t, { host })
  await pythonTool(directory, 'noisy', `import os
os.write(1, b'diagnostic\\n' * 100000)
os.write(2, b'diagnostic\\n' * 100000)
from kinex import args, finish
finish(len(args()['value']))
`)
  const args = { value: 'x'.repeat(3 * 1024 * 1024) }
  const response = await runtime.tools.call('noisy', args, { sessionID: 's' })
  assert.ok(!response.isError, response.output)
  assert.equal(JSON.parse(response.output), args.value.length)
  await pythonTool(directory, 'exits', 'raise RuntimeError("exit before startup")\n')
  const exited = await runtime.tools.call('exits', args, { sessionID: 's' })
  assert.equal(exited.isError, true)
  assert.match(exited.output, /cannot send tool request|exit before startup/)
  const dir = await pythonDriver(runtime, directory, false)
  await writeFile(path.join(dir, 'driver.py'), 'raise RuntimeError("exit before startup")\n')
  await assert.rejects(runtime.devices.dispatch('sensor', 'read', args), /cannot send request|exit before startup/)
})

test('blocked startup writes respect cancellation and deadlines', { timeout: 20000 }, async t => {
  for (const mode of ['cancel', 'timeout']) await t.test(mode, async t => {
    const { runtime, directory } = await fixture(t, { host })
    const code = 'import time\ntime.sleep(30)\n'
    await pythonTool(directory, 'blocked', code, 'perception', 1)
    const dir = await pythonDriver(runtime, directory, false)
    await writeFile(path.join(dir, 'driver.py'), code)
    const args = { value: 'x'.repeat(3 * 1024 * 1024) }
    const start = Date.now()
    const result = await runtime.tools.call('blocked', args, { sessionID: 's',
      ...(mode === 'cancel' ? { signal: AbortSignal.timeout(300) } : {}),
    })
    assert.equal(result.isError, true)
    assert.match(result.output, /abort|interrupt|timed out|timeout/i)
    await assert.rejects(runtime.devices.dispatch('sensor', 'read', args,
      mode === 'cancel' ? AbortSignal.timeout(300) : undefined), /abort|timeout|exited|cannot send request/i)
    assert.ok(Date.now() - start < 8000)
  })
})

test('core discovery and context contain robotics tools and packaged assets', async t => {
  const { runtime } = await fixture(t)
  const { tools, problems } = await runtime.tools.list()
  assert.deepEqual(problems, [])
  assert.ok(tools.some(tool => tool.name === 'device'))
  for (const name of ['shell', 'read', 'write', 'edit', 'todo', 'record', 'calib_plan', 'calib_write', 'calib_sample', 'device_calibrate']) assert.ok(!tools.some(tool => tool.name === name))
  assert.ok(await runtime.skills.load('setup-device'))
  assert.ok(tools.some(tool => tool.name === 'profile_write'))
  assert.ok((await runtime.devices.templates()).some(template => template.name === 'world'))
  assert.equal(typeof runtime.devices.unregister, 'function')
  assert.ok((await runtime.context()).robotics.includes('sensor'))
  assert.ok((await runtime.readiness()).items)
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
      feedback: { velocities: true, efforts: false },
      stop: { behavior: 'hold', affected_devices: ['arm'] },
    },
  })
  const pred = path.join(directory, '.kinex/tool/settled')
  await mkdir(pred, { recursive: true })
  for (const name of ['tool.py', 'tool.yaml']) await writeFile(path.join(pred, name), await readFile(new URL(`../assets/builtin/tool/settled/${name}`, import.meta.url), 'utf8') + (name.endsWith('yaml') ? '\ninterpreter: python3\n' : ''))
  const closedLoop = path.join(directory, '.kinex/tool/closed-loop')
  await mkdir(closedLoop, { recursive: true })
  for (const name of ['tool.py', 'tool.yaml']) {
    const source = await readFile(new URL(`../assets/builtin/tool/closed-loop/${name}`, import.meta.url), 'utf8')
    await writeFile(path.join(closedLoop, name), source + (name.endsWith('yaml') ? '\ninterpreter: python3\n' : ''))
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
  const pending = runtime.tools.call('closed_loop', {
    perceive: { tool: 'slow_point' }, process: { tool: 'relative_pose', args: { parent: { frame: 'arm' } }, inputs: { '/child': '' } },
    control: { tool: 'servo', args: { device: 'arm' } },
    world: 'world', wait_s: .1, until: { tool: 'settled' },
  }, { sessionID: 's', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]) })
  const settled = pending.then(result => ({ result }), error => ({ error }))
  await Promise.race([ready, settled.then(outcome => { throw new Error(`closed_loop exited before perception: ${JSON.stringify(outcome)}`) })])
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
            return {'ok': True, 'tag': args['actions'][0][0], 'execution_id': 'test', 'state': {'positions': [0], 'velocities': [0], 'efforts': [], 'faults': [], 'timestamp': time.monotonic()}}
        finally:
            active = False
    if action == 'read':
        if args.get('release'): release.set()
        if args.get('sleep'): time.sleep(args['sleep'])
    return {'ok': True, 'active': active, 'started': list(started), 'positions': [0], 'velocities': [0], 'efforts': [], 'faults': [], 'timestamp': time.monotonic(), **args}
run(dispatch, lambda: None)
`
async function concurrentFixture(t) {
  const value = await fixture(t, { host, enableRecording: true })
  await value.runtime.profiles.writeDevice({ name: 'sensor', type: 'joint', intrinsics: {
    model: { format: 'joints', joints: [{ name: 'j0', type: 'revolute', limits: { min: -2, max: 2 }, max_velocity: 2, max_effort: null }] },
    home: null, control: { mode: 'position' },
    feedback: { velocities: true, efforts: false },
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
      feedback: { velocities: true, efforts: false },
      stop: { behavior: 'hold', affected_devices: ['arm'] },
    },
  })
  for (const args of [
    { actions: [], duration_s: .02 }, { actions: [[0.1], [3]], duration_s: .02 },
    { actions: [[0.1]], duration_s: 1, block_s: 0 },
    { actions: [[0.1]], freq_hz: 0 }, { target: [0.1], for_s: 1 },
  ]) await assert.rejects(runtime.devices.dispatch('arm', 'write', args))
  assert.equal((await runtime.devices.dispatch('arm', 'read')).data.timestamp, 0)
  await runtime.profiles.writeDevice({ name: 'world', type: 'world', loaded: true, access: { connection: { kind: 'mock' } } })
  const sequence = (await runtime.devices.dispatch('arm', 'write', { actions: [[0.1], [0.2]], duration_s: .08 })).data
  assert.match(sequence.execution_id, /^[0-9a-f]{16}$/)
  assert.equal(sequence.state.timestamp, 0)
  assert.ok(!('elapsed_s' in sequence))
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


for (const deviceType of ['joint', 'dexterous_hand']) test(`servo plans and validates ${deviceType} motion through the runtime`, async t => {
  const name = deviceType === 'joint' ? 'arm' : 'hand'
  const { runtime, directory } = await fixture(t, { host })
  await runtime.profiles.writeDevice({ name: 'world', type: 'world', loaded: true, access: { connection: { kind: 'mock' } } })
  await runtime.profiles.writeDevice({ name, type: deviceType, loaded: true,
    access: { connection: { kind: 'mock' } }, intrinsics: {
      model: { format: 'joints', joints: [0, 1].map(i => ({ name: `j${i}`, type: 'revolute', limits: { min: -3, max: 3 }, max_velocity: 1, max_acceleration: 3, max_effort: null })) },
      ...(deviceType === 'dexterous_hand' ? { geometry: { fingers: { index: {
        chain: [{ joint: 'j0', origin: [0, 0, 0, 0, 0, 0, 1], axis: [0, 0, 1], anchor: [0, 0, 0], reference: 0 }],
        tip_frame: 'index_tip', tip_offset: [0, 0, .05, 0, 0, 0, 1],
      } } } } : {}),
      home: null, control: { mode: 'position' },
      feedback: { velocities: true, efforts: false },
      stop: { behavior: 'hold', affected_devices: [name] },
    },
  })
  const dir = path.join(directory, '.kinex/tool/servo')
  await mkdir(dir, { recursive: true })
  for (const name of ['tool.py', 'tool.yaml']) {
    const source = await readFile(new URL(`../assets/builtin/tool/servo/${name}`, import.meta.url), 'utf8')
    await writeFile(path.join(dir, name), source + (name.endsWith('yaml') ? '\ninterpreter: python3\n' : ''))
  }
  const events = []
  t.after(runtime.subscribe(({ type, event }) => { if (type === 'device') events.push(event) }))
  const obsolete = await runtime.tools.call('servo', { device: name, joints: [2, 1], duration_s: 2.5 }, { sessionID: 's' })
  assert.equal(obsolete.isError, true)
  assert.match(obsolete.output, /duration_s/)
  assert.ok(!events.some(event => event.action === 'write'))
  const pose = await runtime.tools.call('servo', { device: name, pose: [0, 0, 0, 0, 0, 0, 1] }, { sessionID: 's' })
  assert.equal(pose.isError, true)
  assert.match(pose.output, /pose goals require declared IK/)
  assert.ok(!events.some(event => event.action === 'ik' || event.action === 'write'))
  for (const extra of [{ max_joint_delta: 1 }, { max_joint_delta: null }, { ik: {} }, { block: 'true' },
    { block: null }, { block: true, world: name }, { block: true, world: 'missing' }]) {
    const invalid = await runtime.tools.call('servo', { device: name, joints: [2, 1], ...extra }, { sessionID: 's' })
    assert.equal(invalid.isError, true)
  }
  assert.ok(!events.some(event => event.action === 'write' || event.action === 'stop'))
  const response = await runtime.tools.call('servo', { device: name, joints: [2, 1] }, { sessionID: 's' })
  assert.ok(!response.isError, response.output)
  const result = JSON.parse(response.output)
  const submission = events.find(event => event.action === 'write').reading.data
  assert.match(submission.execution_id, /^[0-9a-f]{16}$/)
  assert.deepEqual(result, { device: name, execution_id: submission.execution_id,
    joints: [2, 1], duration_s: 3.75, actions_submitted: 375 })
  assert.deepEqual(submission.state.positions, [0, 0])
  assert.deepEqual((await runtime.devices.dispatch(name, 'read')).data.positions, [0, 0])
  assert.ok(!events.some(event => event.action === 'wait' || event.action === 'stop'))
  await runtime.devices.dispatch('world', 'wait', { duration_s: 2.5 })
  const midway = (await runtime.devices.dispatch(name, 'read')).data.positions
  assert.ok(Math.abs(midway[0] - 1.5802469135802466) < 1e-12)
  await runtime.devices.dispatch('world', 'wait', { duration_s: result.duration_s - 2.5 })
  assert.deepEqual((await runtime.devices.dispatch(name, 'read')).data.positions, [2, 1])
  await runtime.devices.dispatch('world', 'wait', { duration_s: 10 })
  assert.deepEqual((await runtime.devices.dispatch(name, 'read')).data.positions, [2, 1])

  const submit = async joints => {
    const response = await runtime.tools.call('servo', { device: name, joints }, { sessionID: 's' })
    assert.ok(!response.isError, response.output)
    return JSON.parse(response.output)
  }
  await submit([0, 0])
  await runtime.devices.dispatch('world', 'wait', { duration_s: .1 })
  const replacement = await submit([1, .5])
  await runtime.devices.dispatch('world', 'wait', { duration_s: replacement.duration_s + 10 })
  assert.deepEqual((await runtime.devices.dispatch(name, 'read')).data.positions, [1, .5])
  const interrupted = await submit([0, 0])
  await runtime.devices.dispatch('world', 'wait', { duration_s: .1 })
  await runtime.devices.dispatch(name, 'stop')
  const stopped = (await runtime.devices.dispatch(name, 'read')).data.positions
  await runtime.devices.dispatch('world', 'wait', { duration_s: interrupted.duration_s + 10 })
  assert.deepEqual((await runtime.devices.dispatch(name, 'read')).data.positions, stopped)

  for (const world of [undefined, 'simulation']) {
    if (world) await runtime.profiles.writeDevice({ name: world, type: 'world', loaded: true, access: { connection: { kind: 'mock' } } })
    events.length = 0
    const joints = world ? [1, .5] : [0, 0]
    const response = await runtime.tools.call('servo', { device: name, joints, block: true,
      ...(world ? { world } : {}) }, { sessionID: 's' })
    assert.ok(!response.isError, response.output)
    const result = JSON.parse(response.output)
    const waits = events.filter(event => event.action === 'wait')
    assert.equal(waits.length, 1)
    assert.equal(waits[0].reading.data.waited_s, result.duration_s)
    assert.deepEqual((await runtime.devices.dispatch(name, 'read')).data.positions, joints)
    assert.ok(!events.some(event => event.action === 'stop'))
  }
})

test('servo and policy reject invalid write feedback and faults through core validation', async t => {
  const { runtime, directory } = await fixture(t, { host })
  await runtime.profiles.writeDevice({ name: 'sensor', type: 'joint', loaded: true,
    access: { connection: { kind: 'mock' }, driver: { interpreter: 'python3', persistent: true,
      actions: ['load', 'unload', 'status', 'read', 'write', 'stop'], timeout_s: 2 } },
    intrinsics: {
      model: { format: 'joints', joints: [{ name: 'j0', type: 'revolute', limits: { min: -2, max: 2 }, max_velocity: 1, max_effort: null }] },
      home: null, control: { mode: 'position' }, feedback: { velocities: true, efforts: false },
      stop: { behavior: 'hold', affected_devices: ['sensor'] },
    },
  })
  const dir = path.join(directory, '.kinex', 'devices', 'sensor')
  await writeFile(path.join(dir, 'driver.py'), `from kinex.driver_protocol import run
def dispatch(action, args):
    state = {'positions': [0], 'velocities': [0], 'efforts': [], 'faults': [], 'timestamp': 1}
    if action == 'read':
        return {'ok': True, **state}
    if action == 'write':
        if args['actions'][-1][0] < 0:
            state['positions'] = []
        else:
            state['faults'] = [{'code': 'test_fault'}]
        return {'ok': True, 'execution_id': 'submission', 'state': state}
    if action == 'stop':
        with open('stops', 'a') as output: output.write('stop\\n')
    return {'ok': True}
run(dispatch, lambda: None)
`)
  await (await runtime.devices.load('sensor')).ready
  await pythonTool(directory, 'servo', await readFile(new URL('../assets/builtin/tool/servo/tool.py', import.meta.url), 'utf8'), 'controller')
  await pythonTool(directory, 'run_policy', await readFile(new URL('../assets/builtin/tool/run-policy/tool.py', import.meta.url), 'utf8'), 'controller')
  await runtime.profiles.writeDevice({ name: 'policy', type: 'model', loaded: false,
    access: { connection: { kind: 'process', compute: { kind: 'cpu' } }, driver: {
      interpreter: 'python3', actions: ['load', 'unload', 'status', 'infer'],
    } }, intrinsics: { operations: [{ name: 'infer',
      input: { type: 'object', properties: { obs: { type: 'object', properties: { goal: { type: 'number' } }, required: ['goal'] } }, required: ['obs'] },
      output: { type: 'object', properties: { actions: { type: 'array', items: { type: 'array', items: { type: 'number' } } } }, required: ['actions'] },
    }] } })
  await writeFile(path.join(directory, '.kinex/devices/policy/driver.py'), `from kinex.driver_protocol import run
def dispatch(action, args):
    if action == 'infer': return {'ok': True, 'actions': [[args['obs']['goal']]]}
    return {'ok': True}
run(dispatch, lambda: None)
`)
  await (await runtime.devices.load('policy')).ready
  let stops = 0
  for (const tool of ['servo', 'run_policy']) for (const [goal, error] of [[-1, /positions/], [1, /write reported faults/]]) {
    const args = tool === 'servo' ? { device: 'sensor', joints: [goal] }
      : { model: 'policy', observation: { goal }, command: [{ device: 'sensor' }] }
    const response = await runtime.tools.call(tool, args, { sessionID: 's' })
    assert.equal(response.isError, true)
    assert.match(response.output, error)
    const count = (await readFile(path.join(dir, 'stops'), 'utf8')).trim().split('\n').length
    assert.ok(count > stops, 'each invalid submission triggers stop cleanup')
    stops = count
  }
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
        feedback: { velocities: true, efforts: false },
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
  await install('closed-loop', await readFile(new URL('../assets/builtin/tool/closed-loop/tool.yaml', import.meta.url), 'utf8'),
    await readFile(new URL('../assets/builtin/tool/closed-loop/tool.py', import.meta.url), 'utf8'))
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

test('closed_loop discovers the new name and treats omitted and null stages as empty callables', async t => {
  const { runtime, events } = await trackingFixture(t)
  const names = (await runtime.tools.list()).tools.map(tool => tool.name)
  assert.ok(names.includes('closed_loop'))
  assert.ok(!names.includes('track'))
  const stages = ['perceive', 'process', 'control', 'until']
  for (const optional of [{}, Object.fromEntries(stages.map(stage => [stage, null])),
    Object.fromEntries(stages.map(stage => [stage, { python: 'lambda **kwargs: {}' }]))]) {
    events.length = 0
    const response = await runtime.tools.call('closed_loop', {
      world: 'world', wait_s: .1, max_rounds: 2, ...optional,
    }, { sessionID: 's' })
    assert.ok(!response.isError, response.output)
    assert.deepEqual(JSON.parse(response.output), {
      terminated_by: 'max_rounds', rounds: 2, perception_misses: 0, last: {}, until_state: null,
    })
    assert.equal(events.filter(event => event.action === 'wait').length, 2)
    assert.ok(!events.some(event => ['write', 'stop'].includes(event.action)))
  }
})

test('closed_loop uses static control arguments without perception or processing', async t => {
  const { runtime, events } = await trackingFixture(t)
  for (const optional of [{}, { perceive: null, process: null, until: null }]) {
    events.length = 0
    const response = await runtime.tools.call('closed_loop', {
      world: 'world', wait_s: .1, max_rounds: 2,
      control: { tool: 'act', args: { target: .2 } }, ...optional,
    }, { sessionID: 's' })
    assert.ok(!response.isError, response.output)
    const result = JSON.parse(response.output)
    assert.equal(result.terminated_by, 'max_rounds')
    assert.equal(result.perception_misses, 0)
    assert.deepEqual(result.last, { custom: true })
    assert.equal(events.filter(event => event.action === 'write').length, 4)
    for (const name of ['arm', 'hand']) assert.equal((await runtime.devices.dispatch(name, 'read')).data.stopped, true)
  }
})

test('closed_loop supplies empty observations and discards observations when processing is disabled', async t => {
  const { runtime } = await trackingFixture(t)
  for (const explicit of [false, true]) for (const skipped of ['perceive', 'process']) {
    const stages = skipped === 'perceive' ? {
      process: { python: "def main(observation):\n    assert observation == {}\n    return {'target': .2}" },
    } : { perceive: { python: "lambda: {'target': .9}" } }
    const response = await runtime.tools.call('closed_loop', {
      world: 'world', wait_s: .1, max_rounds: 2, ...stages,
      ...(explicit ? { [skipped]: null } : {}),
      control: { tool: 'act', args: { target: .2 } },
      until: { python: `def main(context, state):
    if context['round']:
        assert context['control_args'] == {'target': .2}
        assert context['control_result'] == {'custom': True}
    return {'done': context['round'] == 1}
` },
    }, { sessionID: 's' })
    assert.ok(!response.isError, response.output)
    assert.equal(JSON.parse(response.output).terminated_by, 'until')
    assert.equal(JSON.parse(response.output).rounds, 1)
  }
})

test('closed_loop monitors a predicate without control and defaults missing done to false', async t => {
  const { runtime, events } = await trackingFixture(t)
  for (const optional of [{}, { control: null }]) {
    events.length = 0
    const response = await runtime.tools.call('closed_loop', {
      world: 'world', wait_s: .1, max_rounds: 3, ...optional,
      until: { python: `def main(context, state):
    if context['round']:
        assert context['control_result'] == {}
    checks = (state or 0) + 1
    return {'state': checks, **({'done': True} if checks == 3 else {})}
` },
    }, { sessionID: 's' })
    assert.ok(!response.isError, response.output)
    assert.deepEqual(JSON.parse(response.output), {
      terminated_by: 'until', rounds: 2, perception_misses: 0, last: {}, until_state: 3,
    })
    assert.equal(events.filter(event => event.action === 'wait').length, 2)
    assert.ok(!events.some(event => ['write', 'stop'].includes(event.action)))
  }
})

test('closed_loop still rejects malformed stages and predicate results', async t => {
  const { runtime, events } = await trackingFixture(t)
  const base = { world: 'world', wait_s: .1, max_rounds: 1 }
  for (const stage of ['perceive', 'process', 'control', 'until']) {
    const response = await runtime.tools.call('closed_loop', { ...base, [stage]: {} }, { sessionID: 's' })
    assert.equal(response.isError, true)
  }
  for (const value of ['None', '[]', 'False', "{'done': None}", "{'done': 1}", "{'done': 'false'}"]) {
    const response = await runtime.tools.call('closed_loop', {
      ...base, until: { python: `lambda **kwargs: ${value}` },
    }, { sessionID: 's' })
    assert.equal(response.isError, true)
    assert.match(response.output, /until must return a dict with optional done: boolean/)
  }
  assert.ok(!events.some(event => ['write', 'wait'].includes(event.action)))
})

test('failed large startup writes in composed tools stop owned motion', async t => {
  const { runtime, directory, events } = await trackingFixture(t)
  await pythonTool(directory, 'blocked', 'import time\ntime.sleep(30)\n', 'perception', 1)
  await pythonTool(directory, 'starts', `from kinex import args, device, call, finish
device('arm', 'write', actions=[[.2]], duration_s=.1)
finish(call('blocked', value=args()['value']))
`, 'controller')
  const result = await runtime.tools.call('starts', { value: 'x'.repeat(3 * 1024 * 1024) }, { sessionID: 's' })
  assert.equal(result.isError, true)
  assert.match(result.output, /timeout|timed out/i)
  assert.deepEqual(events.filter(e => e.action === 'stop').map(e => e.device.name), ['arm'])
  assert.equal((await runtime.devices.dispatch('arm', 'read')).data.stopped, true)
})

test('closed_loop maps fresh camera file entries to controllers without encoding image bytes', async t => {
  const { runtime, directory, args } = await trackingFixture(t)
  const dir = await pythonDriver(runtime, directory, false)
  await writeFile(path.join(dir, 'source.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64'))
  await writeFile(path.join(dir, 'driver.py'), `from pathlib import Path
import secrets
from kinex.driver_protocol import run
def dispatch(action, args):
    frame = Path(secrets.token_hex(8) + '.png').resolve()
    frame.write_bytes(Path('source.png').read_bytes())
    return {'ok': True, 'file': str(frame)}
run(dispatch, lambda: None)
`)
  const image = await runtime.tools.call('device', { deviceID: 'sensor' }, { sessionID: 's' })
  assert.ok(!image.isError, image.output)
  assert.equal(image.attachments, undefined)
  assert.match(JSON.parse(image.output).file, /\.png$/)
  const result = await runtime.tools.call('closed_loop', { ...args, max_rounds: 2,
    perceive: { python: 'from kinex import device\ndef main():\n    return {"image": device("sensor")["file"]}\n' },
    process: { python: 'lambda observation: observation' },
    control: { python: `from pathlib import Path
def main(observation):
    image = observation['images'][0]
    assert Path(image).read_bytes().startswith(b'\\x89PNG')
    return image
`, inputs: { '/observation/images/0': '/image' } },
    until: { python: 'lambda context, state: {"done": False, "state": (state or []) + ([context["control_result"]] if context["round"] else [])}' },
  }, { sessionID: 's' })
  assert.ok(!result.isError, result.output)
  const value = JSON.parse(result.output)
  assert.equal(new Set(value.until_state).size, 2)
  assert.equal(value.last, value.until_state[1])
  for (const file of value.until_state) assert.deepEqual(await readFile(file), await readFile(path.join(dir, 'source.png')))
})

test('closed_loop passes large generated observations through stages and predicate context', async t => {
  const { runtime, args } = await trackingFixture(t)
  const result = await runtime.tools.call('closed_loop', { ...args,
    perceive: { python: 'lambda: {"samples": list(range(60000))}' },
    process: { python: 'lambda observation: observation' },
    control: { python: 'lambda samples: {"count": len(samples)}' },
    until: { python: `def main(context, state):
    if not context['round']:
        return {'done': False}
    assert context['observation']['samples'] == list(range(60000))
    assert context['control_args']['samples'] == context['observation']['samples']
    return {'done': True, 'state': context['control_result']['count']}
` },
  }, { sessionID: 's' })
  assert.ok(!result.isError, result.output)
  assert.deepEqual(JSON.parse(result.output), {
    terminated_by: 'until', rounds: 1, perception_misses: 0, last: { count: 60000 }, until_state: 60000,
  })
})

test('closed_loop stops owned actuators on misses and errors, excluding model inference and unrelated motion', async t => {
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
      const response = await runtime.tools.call('closed_loop', { ...args, process: { tool: 'convert', args: { mode } } }, { sessionID: 's' })
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
    const response = await runtime.tools.call('closed_loop', { ...args, process: { tool: 'convert', args: { mode } } }, { sessionID: 's' })
    assert.equal(response.isError, true, mode)
    assert.match(response.output, error)
  }
  assert.ok(!events.some(e => e.action === 'write' || e.action === 'stop'))
})

test('cancelling closed_loop during processing stops owned motion without stopping its replacement', { timeout: 15000 }, async t => {
  const { runtime, args, events } = await trackingFixture(t)
  let started
  const ready = new Promise(resolve => { started = resolve })
  t.after(runtime.subscribe(({ type, event }) => {
    if (type === 'device' && event.device.name === 'sensor' && event.action === 'read') started()
  }))
  const abort = new AbortController()
  t.after(() => abort.abort())
  const pending = runtime.tools.call('closed_loop', { ...args, process: { tool: 'convert', args: { mode: 'wait' } } },
    { sessionID: 's', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]) })
  await Promise.race([ready, pending.then(response => { throw Error(`closed_loop exited before processing wait: ${response.output}`) })])
  await runtime.devices.dispatch('arm', 'write', { actions: [[.8]], duration_s: .1 })
  abort.abort()
  assert.equal((await pending).isError, true)
  assert.deepEqual([...new Set(events.filter(e => e.action === 'stop').map(e => e.device.name))], ['hand'])
  assert.equal((await runtime.devices.dispatch('arm', 'read')).data.stopped, false)
  assert.equal((await runtime.devices.dispatch('hand', 'read')).data.stopped, true)
})

test('world read exposes driver time budgets without advancing time or changing waits', async t => {
  const { runtime, directory } = await fixture(t, { host })
  for (const [name, maximum] of [['bounded', .1], ['unbounded', null], ['absent', undefined]]) {
    await runtime.profiles.writeDevice({ name, type: 'world', loaded: false,
      access: { connection: { kind: 'process' }, driver: {
        interpreter: 'python3', persistent: true, actions: ['read', 'wait', 'load', 'unload', 'status'],
      } } })
    await writeFile(path.join(directory, `.kinex/devices/${name}/driver.py`), `from kinex.driver_protocol import run
elapsed = 0.0
def dispatch(action, args):
    global elapsed
    if action not in ('read', 'wait'):
        return {'ok': True, 'loaded': action != 'unload'}
    duration = args.get('duration_s', 0)
    if action == 'wait':
        elapsed += duration
    budget = ${maximum === undefined ? '{}' : `{'budget': {'used_s': elapsed, 'max_s': ${maximum === null ? 'None' : maximum}}}`}
    return {'ok': True, 'time_s': 1000 + elapsed, 'waited_s': duration, 'extra': True, **budget}
run(dispatch, lambda: None)
`)
    await (await runtime.devices.load(name)).ready
    const expected = used_s => ({ time_s: 1000 + used_s,
      ...(maximum === undefined ? {} : { budget: { used_s, max_s: maximum } }) })
    for (const verbose of [true, false]) for (const compact of [true, false]) {
      const response = await runtime.tools.call('device', { deviceID: name, action: 'read', verbose, compact }, { sessionID: 's' })
      assert.ok(!response.isError, response.output)
      assert.deepEqual(JSON.parse(response.output), expected(0))
    }
    for (const time_s of [1000.25, 1000.5]) {
      const wait = await runtime.tools.call('device', { deviceID: name, action: 'wait', args: { duration_s: .25 } }, { sessionID: 's' })
      assert.ok(!wait.isError, wait.output)
      assert.deepEqual(JSON.parse(wait.output), { time_s, waited_s: .25 })
      assert.deepEqual((await runtime.devices.dispatch(name, 'read')).data, expected(time_s - 1000))
    }
  }
})

test('cancelling one world wait leaves concurrent waits and the driver usable', async t => {
  const { runtime, directory } = await fixture(t)
  await runtime.profiles.writeDevice({ name: 'world', type: 'world', loaded: false,
    access: { connection: { kind: 'process' }, driver: {
      interpreter: 'python3', persistent: true, actions: ['read', 'wait', 'load', 'unload', 'status'],
    } } })
  await writeFile(path.join(directory, '.kinex/devices/world/driver.py'),
    `import time
from kinex.driver_protocol import run, check_cancelled
def dispatch(action, args):
    start = time.monotonic()
    if action == 'wait':
        while time.monotonic() - start < args['duration_s']:
            check_cancelled()
            time.sleep(.005)
        return {'time_s': time.monotonic(), 'waited_s': time.monotonic() - start}
    return {'ok': True, 'time_s': time.monotonic()}
run(dispatch, lambda: None)
`)
  await (await runtime.devices.load('world')).ready
  const cancelled = new AbortController()
  const long = runtime.devices.dispatch('world', 'wait', { duration_s: 5 }, cancelled.signal)
  const rejected = assert.rejects(long)
  const short = runtime.devices.dispatch('world', 'wait', { duration_s: .2 })
  await delay(50)
  cancelled.abort(new Error('cancel this wait'))
  await rejected
  assert.ok((await short).data.waited_s >= .2)
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
      intrinsics: { control, feedback: type === 'gripper' ? { aperture_m: false } : { positions: [], velocities: false },
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
    const observed = (await runtime.devices.dispatch(type, 'read')).data
    if (type === 'suction') assert.deepEqual(observed.positions, [actions.at(-1)])
    else { assert.equal(observed.positions, undefined); assert.equal(observed.aperture_m, null) }
    await write({ actions: [actions[0]] })
    await runtime.devices.dispatch('world', 'wait', { duration_s: .2 })
    const state = (await runtime.devices.dispatch(type, 'read')).data
    if (type === 'suction') assert.deepEqual(state.positions, [actions[0]])
    else assert.equal(state.positions, undefined)
    assert.equal(state.stopped, false)
  }
})

test('dispatch rejects stale gripper feedback and stops invalid write results', async t => {
  const { runtime, directory } = await fixture(t)
  await runtime.profiles.writeDevice({ name: 'gripper', type: 'gripper', loaded: true,
    access: { connection: { kind: 'mock' }, driver: { interpreter: 'python3', persistent: true,
      actions: ['read', 'write', 'stop', 'load', 'unload', 'status'] } },
    intrinsics: { control: { mode: 'direction', open_target: -1, close_target: 1 },
      feedback: { aperture_m: true }, stop: { behavior: 'hold', affected_devices: ['gripper'] } },
  })
  const dir = path.join(directory, '.kinex', 'devices', 'gripper')
  await writeFile(path.join(dir, 'driver.py'), `from kinex.driver_protocol import run
state = {'aperture_m': .04, 'faults': [], 'timestamp': 1}
def dispatch(action, args):
    if action == 'read':
        return {'ok': True, **state, 'object_detected': None}
    if action == 'write':
        result = {'execution_id': 'submission', 'state': dict(state)}
        if args['actions'][0] < 0:
            result['elapsed_s'] = 0
        else:
            result['state']['frame_poses'] = {}
        return {'ok': True, **result}
    if action == 'stop':
        with open('stops', 'a') as output: output.write('stop\\n')
    return {'ok': True}
run(dispatch, lambda: None)
`)
  await (await runtime.devices.load('gripper')).ready
  await assert.rejects(runtime.devices.dispatch('gripper', 'read'), /object_detected/)
  for (const value of [-1, 1])
    await assert.rejects(runtime.devices.dispatch('gripper', 'write', { actions: [value], duration_s: .1 }))
  assert.deepEqual((await readFile(path.join(dir, 'stops'), 'utf8')).trim().split('\n'), ['stop', 'stop'])
})

test('device failure metadata survives tools, Python composition and controller cleanup', async t => {
  const { runtime, directory } = await fixture(t, { host })
  const details = { effects: 'unknown', validation_error: 'bad feedback', cleanup_error: 'halt rejected' }
  await runtime.profiles.writeDevice({ name: 'sensor', type: 'joint', loaded: true,
    access: { connection: { kind: 'mock' }, driver: { interpreter: 'python3', persistent: true,
      actions: ['load', 'unload', 'status', 'read', 'write', 'stop'] } },
    intrinsics: {
      model: { format: 'joints', joints: [{ name: 'j0', type: 'revolute', limits: { min: -1, max: 1 }, max_velocity: 1, max_effort: null }] },
      home: null, control: { mode: 'position' }, feedback: { velocities: true, efforts: false },
      stop: { behavior: 'hold', affected_devices: ['sensor'] },
    },
  })
  await writeFile(path.join(directory, '.kinex/devices/sensor/driver.py'), `import sys
from kinex.driver_protocol import run
stops = 0
def dispatch(action, args):
    global stops
    if args.get('fail'):
        print('private driver stderr', file=sys.stderr)
        return {'ok': False, 'error': 'cleanup failed', 'code': 'stop_failed',
                'details': {'effects': 'unknown', 'validation_error': 'bad feedback', 'cleanup_error': 'halt rejected'}}
    if action == 'stop': stops += 1
    state = {'positions': [0], 'velocities': [0], 'efforts': [], 'faults': [], 'timestamp': 1, 'stops': stops}
    return {'ok': True, **({'execution_id': 'submission', 'state': state} if action == 'write' else state)}
run(dispatch, lambda: None)
`)
  await (await runtime.devices.load('sensor')).ready
  await pythonTool(directory, 'rpc_device', 'from kinex import device\ndevice("sensor", fail=True)\n')
  await pythonTool(directory, 'rpc_call', 'from kinex import call\ncall("device", deviceID="sensor", args={"fail": True})\n')
  await pythonTool(directory, 'rpc_batch', 'from kinex import devices, finish\nfinish(devices([{"device": "sensor", "args": {"fail": True}}]))\n')
  await pythonTool(directory, 'rpc_call_batch', 'from kinex import call, finish\nfinish(call("devices", calls=[{"deviceID": "sensor", "args": {"fail": True}}]))\n')
  await pythonTool(directory, 'rpc_catch', `from kinex import device, RPCError, finish
try:
    device('sensor', fail=True)
except RPCError as error:
    assert isinstance(error, RuntimeError)
    finish(error.payload())
`)
  await pythonTool(directory, 'rpc_controller', 'from kinex import device\ndevice("sensor", "write", actions=[[0]], duration_s=.1)\ndevice("sensor", fail=True)\n', 'controller')
  await pythonTool(directory, 'rpc_nested', 'from kinex import call\ncall("rpc_controller")\n', 'controller')
  await pythonTool(directory, 'rpc_inline', `from kinex import inline
inline("lambda: __import__('kinex').call('rpc_controller')", {}, kind='controller')
`, 'controller')
  const check = value => {
    assert.equal(value.code, 'stop_failed')
    assert.deepEqual(value.details, details)
    assert.match(value.error, /cleanup failed/)
    assert.equal(value.stderr, undefined)
  }
  for (const name of ['device', 'devices', 'rpc_device', 'rpc_call', 'rpc_controller', 'rpc_nested', 'rpc_inline']) {
    const one = { deviceID: 'sensor', args: { fail: true } }
    const response = await runtime.tools.call(name, name === 'device' ? one : name === 'devices' ? { calls: [one] } : {}, { sessionID: 's' })
    assert.equal(response.isError, true, response.output)
    assert.doesNotMatch(response.output, /private driver stderr/)
    const value = JSON.parse(response.output)
    check(name === 'devices' ? value.results[0] : value)
  }
  for (const name of ['rpc_batch', 'rpc_call_batch', 'rpc_catch']) {
    const response = await runtime.tools.call(name, {}, { sessionID: 's' })
    assert.ok(!response.isError, response.output)
    const value = JSON.parse(response.output)
    check(name === 'rpc_batch' ? value[0] : name === 'rpc_call_batch' ? value.results[0] : value)
  }
  assert.ok((await runtime.devices.dispatch('sensor', 'read')).data.stops >= 3)
})

test('builtin prerequisites validate selected devices and retain custom global gates', async t => {
  const { runtime, directory } = await fixture(t, { host })
  for (const [name, type, loaded] of [['camera', 'rgbd', true], ['detector', 'segmentation', true],
    ['policy', 'model', true], ['arm', 'joint', true], ['unused', 'rgb', false]]) {
    await runtime.profiles.writeDevice({ name, type, loaded })
  }
  for (const folder of ['run-policy', 'locate-object-3d']) {
    const manifest = await readFile(new URL(`../assets/builtin/tool/${folder}/tool.yaml`, import.meta.url), 'utf8')
    assert.doesNotMatch(manifest, /^(devices|requires):/m)
    const dir = path.join(directory, '.kinex/tool', folder)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'tool.yaml'), manifest + '\ninterpreter: python3\n')
    // Isolate manifest gates from the tools' numerical and device operations.
    await writeFile(path.join(dir, 'tool.py'), 'from kinex import finish\nfinish({"entered": True})\n')
  }
  for (const [name, args] of [
    ['run_policy', { model: 'policy', command: [{ device: 'arm' }], observation: {} }],
    ['locate_object_3d', { camera: 'camera', model: 'detector', prompt: 'cup' }],
  ]) {
    const result = await runtime.tools.call(name, args, { sessionID: 's' })
    assert.ok(!result.isError, result.output)
    assert.deepEqual(JSON.parse(result.output), { entered: true })
  }
  const unloaded = await runtime.tools.call('locate_object_3d', { camera: 'unused', model: 'detector', prompt: 'cup' }, { sessionID: 's' })
  assert.match(unloaded.output, /unused.*unloaded/)
  const wrong = await runtime.tools.call('run_policy', { model: 'camera', command: [{ device: 'arm' }], observation: {} }, { sessionID: 's' })
  assert.match(wrong.output, /accepts model/)
  const custom = await pythonTool(directory, 'custom_gate', 'from kinex import finish\nfinish({})\n')
  await writeFile(path.join(custom, 'tool.yaml'), (await readFile(path.join(custom, 'tool.yaml'), 'utf8')) + 'devices: [imu]\nrequires: intrinsics:imu\n')
  const gated = await runtime.tools.call('custom_gate', {}, { sessionID: 's' })
  assert.match(gated.output, /requires a loaded device of type imu/)
})

test('devices preauthorizes concurrent reads, preserves partial results and returns image paths', async t => {
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
  assert.equal(result.attachments, undefined)
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

test('closed_loop consumes devices results through nested input mappings', async t => {
  const { runtime, directory, args } = await trackingFixture(t)
  const dir = path.join(directory, '.kinex/tool/extract')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'tool.yaml'), 'name: extract\nkind: perception\ndescription: test\ninterpreter: python3\nparameters: {type: object}\n')
  await writeFile(path.join(dir, 'tool.py'), 'from kinex import args, finish\nassert args()["position"] == 0\nfinish({"goal": .2, "unused": True})\n')
  const result = await runtime.tools.call('closed_loop', { ...args, max_rounds: 1,
    perceive: { tool: 'devices', args: { calls: [{ deviceID: 'arm' }] } },
    process: { tool: 'extract', inputs: { '/position': '/results/0/data/positions/0' } },
    control: { tool: 'act', inputs: { '/target': '/goal' } },
  }, { sessionID: 's' })
  assert.ok(!result.isError, result.output)
  assert.equal(JSON.parse(result.output).rounds, 1)
  for (const name of ['arm', 'hand']) assert.equal((await runtime.devices.dispatch(name, 'read')).data.stopped, true)
})

test('closed_loop executes inline stages immediately with mappings, fresh globals and predicate state', async t => {
  const { runtime, directory, args, events } = await trackingFixture(t)
  const closedLoop = path.join(directory, '.kinex/tool/closed-loop')
  await writeFile(path.join(closedLoop, 'offset.json'), '0.1')
  const files = await readdir(path.join(directory, '.kinex/tool'), { recursive: true })
  const result = await runtime.tools.call('closed_loop', { ...args,
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
    const result = await runtime.tools.call('closed_loop', { ...args,
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
    const result = await runtime.tools.call('closed_loop', { ...args,
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
    const result = await runtime.tools.call('closed_loop', { ...args, process: { python } }, { sessionID: 's' })
    assert.equal(result.isError, true)
    assert.match(result.output, error)
  }
  for (const process of [{}, { python: '' }, { tool: 'convert', python: 'lambda observation: {}' }, { python: 'lambda observation: {}', extra: true }]) {
    const result = await runtime.tools.call('closed_loop', { ...args, process }, { sessionID: 's' })
    assert.equal(result.isError, true)
  }
  assert.ok(!events.some(e => e.action === 'write'))
})

test('inline execution inherits cancellation and the closed_loop deadline', { timeout: 20000 }, async t => {
  for (const mode of ['cancel', 'timeout']) await t.test(mode, async t => {
    const { runtime, directory, args, events } = await trackingFixture(t)
    if (mode === 'timeout') {
      const manifest = path.join(directory, '.kinex/tool/closed-loop/tool.yaml')
      await writeFile(manifest, (await readFile(manifest, 'utf8')).replace('timeout_s: 900', 'timeout_s: 1'))
    }
    let started
    const ready = new Promise(resolve => { started = resolve })
    t.after(runtime.subscribe(({ type, event }) => {
      if (type === 'device' && event.device.name === 'sensor' && event.action === 'read') started()
    }))
    const abort = new AbortController()
    t.after(() => abort.abort())
    const pending = runtime.tools.call('closed_loop', { ...args,
      process: { python: `import time
from kinex import device
def main(observation):
    if observation['positions'][0] > 0:
        device('sensor')
        time.sleep(30)
    return {'target': 0.2}
` },
    }, { sessionID: 's', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(12000)]) })
    await Promise.race([ready, pending.then(response => { throw Error(`closed_loop exited before inline wait: ${response.output}`) })])
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

test('camera modes return images to agents and preserve Python output selection', async t => {
  const { runtime, directory } = await fixture(t, { host, enableRecording: true })
  await runtime.profiles.writeDevice({ name: 'camera', type: 'rgbd', loaded: true,
    access: { connection: { kind: 'mock' } }, intrinsics: {
      color: { width: 2, height: 2, pixel_format: 'rgb8', image_format: 'png' },
      depth: { width: 2, height: 2, pixel_format: 'uint16', image_format: 'pgm16_be',
        registration: 'color', quantity: 'z', scale_m_per_unit: .001, invalid_value: 0,
        valid_range_m: { min: .001, max: 65.535 } },
    } })
  await pythonTool(directory, 'camera_modes', `import numpy as np
from kinex import Device, device, devices, call, finish
samples = [device('camera')['data'], device('camera', output='array')['data'],
           Device('camera').read()['data'],
           devices([{'device': 'camera'}])[0]['data'],
           call('device', deviceID='camera'),
           call('devices', calls=[{'deviceID': 'camera'}])['results'][0]['data']]
for sample in samples:
    assert sample['color'].shape == (2, 2, 3) and sample['color'].dtype == np.uint8
    assert sample['depth'].shape == (2, 2) and sample['depth'].dtype == np.uint16
    assert sample['color'].flags.owndata and sample['depth'].flags.writeable
encoded = device('camera', output='base64')['data']
assert isinstance(encoded['color'], str) and isinstance(encoded['depth'], str)
assert call('device', deviceID='camera', args={'output': 'base64'}) == encoded
finish({'timestamp': samples[0]['timestamp']})
`)
  const result = await runtime.tools.call('camera_modes', {}, { sessionID: 's' })
  assert.ok(!result.isError, result.output)
  assert.deepEqual(JSON.parse(result.output), { timestamp: 0 })
  assert.equal(result.attachments, undefined)
  const out = path.join(directory, '.kinex/devices/camera/out')
  await assert.rejects(readdir(out), { code: 'ENOENT' })
  const reads = []
  t.after(runtime.subscribe(({ type, event }) => { if (type === 'device') reads.push(event) }))
  const image = await runtime.tools.call('device', { deviceID: 'camera' }, { sessionID: 's' })
  assert.ok(!image.isError, image.output)
  assert.equal(reads.at(-1).args.output, 'base64')
  assert.deepEqual(JSON.parse(image.output), { deviceID: 'camera', timestamp: 0 })
  const wire = await runtime.devices.dispatch('camera', 'read')
  assert.deepEqual(image.attachments, [{ mime: 'image/png', data: wire.data.color }])
  await runtime.profiles.writeDevice({ name: 'rgb', type: 'rgb', loaded: true,
    access: { connection: { kind: 'mock' } }, intrinsics: {
      color: { width: 3, height: 1, pixel_format: 'rgb8', image_format: 'png' },
    } })
  const rgb = await runtime.devices.dispatch('rgb', 'read')
  const batch = await runtime.tools.call('devices', { calls: [
    { deviceID: 'rgb' }, { deviceID: 'missing' }, { deviceID: 'sensor' }, { deviceID: 'camera' },
  ] }, { sessionID: 's' })
  assert.equal(batch.isError, true)
  assert.deepEqual(batch.attachments.map(image => image.data), [rgb.data.color, wire.data.color])
  assert.deepEqual(JSON.parse(batch.output).results.map(row => row.deviceID), ['rgb', 'missing', 'sensor', 'camera'])
  assert.doesNotMatch(batch.output, /color|depth|attachments|iVBOR/)
  await assert.rejects(readdir(out), { code: 'ENOENT' })
  assert.deepEqual((await runtime.devices.dispatch('camera', 'read', { output: 'base64' })).data, wire.data)
  for (const name of ['device', 'devices']) for (const output of ['array', 'base64', 'file']) {
    const call = { deviceID: 'camera', args: { output } }
    const response = await runtime.tools.call(name, name === 'device' ? call : { calls: [call] }, { sessionID: 's' })
    assert.ok(!response.isError, response.output)
    assert.deepEqual(response.attachments, image.attachments)
    assert.equal(reads.at(-1).args.output, output)
    assert.doesNotMatch(response.output, /"color"|"depth"|iVBOR/)
  }
  await assert.rejects(runtime.devices.dispatch('camera', 'read', { output: 'bytes' }))
  await pythonTool(directory, 'camera_file', `from kinex import device, finish
finish(device('camera', output='file'))
`)
  const file = await runtime.tools.call('camera_file', {}, { sessionID: 's' })
  assert.ok(!file.isError, file.output)
  const saved = JSON.parse(file.output)
  assert.deepEqual(await readFile(saved.file), Buffer.from(wire.data.color, 'base64'))
  assert.deepEqual(await readFile(saved.data.depth_file), Buffer.from(wire.data.depth, 'base64'))
  const recording = await runtime.recording.start({ specs: { sensor: { rate: 1 } }, sessionID: 's' })
  await runtime.devices.dispatch('camera', 'read')
  await runtime.recording.stop()
  const recorded = path.join(directory, '.kinex/recordings', recording.manifest.id)
  const events = (await readFile(path.join(recorded, 'passive/camera/events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  const frame = events.find(event => event.file)
  assert.ok(frame.depthFile)
  assert.equal(frame.data.color, undefined)
  assert.equal(frame.data.depth, undefined)
  assert.equal(frame.data.timestamp, 0)
  assert.ok((await readFile(path.join(recorded, frame.file))).length > 0)
})

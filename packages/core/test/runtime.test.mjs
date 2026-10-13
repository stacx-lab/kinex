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
  const dir = path.join(directory, '.kinex/tools', name)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'tool.yaml'), `name: ${name}\nkind: ${kind}\ndescription: test\ninterpreter: python3\ntimeout_s: ${timeout}\nparameters: {type: object}\n`)
  await writeFile(path.join(dir, 'tool.py'), code)
  return dir
}

const execScript = (runtime, input, invocation = {}) => runtime.tools.call('exec',
  { interpreter: 'python3', ...input }, { sessionID: 'exec-test', ...invocation })

test('exec runs ordinary source and files with normal globals, arguments and runtime access', async t => {
  const { runtime, directory } = await fixture(t, { host })
  const source = `import sys, os, __main__
from kinex import args, robot
assert __name__ == '__main__'
assert __main__.__dict__ is globals()
assert sys.stdin.read() == '' and os.read(0, 1) == b''
assert args() == {'value': 7}
assert sys.argv[1:] == ['hello', 'two words']
print(robot()['identity']['id'])
print('ordinary script')
`
  const options = { description: 'inspect runtime', args: { value: 7 }, argv: ['hello', 'two words'] }
  const inline = await execScript(runtime, { python: source, ...options })
  assert.ok(!inline.isError, inline.output)
  assert.deepEqual(JSON.parse(inline.output), { exit_code: 0, output: 'node-test\nordinary script\n', result: null })
  const scripts = path.join(directory, 'scripts')
  await mkdir(scripts)
  await writeFile(path.join(scripts, 'helper.py'), 'value = 9\n')
  await writeFile(path.join(scripts, 'my script.py'), `${source}
from helper import value
from pathlib import Path
assert value == 9 and Path(__file__).name == 'my script.py'
assert Path.cwd() == Path(__file__).parent.parent
`)
  const file = await execScript(runtime, { file: 'scripts/my script.py', ...options })
  assert.ok(!file.isError, file.output)
  assert.deepEqual(JSON.parse(file.output), JSON.parse(inline.output))
  const plain = await execScript(runtime, { python: 'print("no runtime imports")' })
  assert.equal(JSON.parse(plain.output).output, 'no runtime imports\n')
  for (const python of ['pass', 'import sys; sys.exit(0)', 'import os; os._exit(0)']) {
    const result = await execScript(runtime, { python })
    assert.ok(!result.isError, result.output)
    assert.deepEqual(JSON.parse(result.output), { exit_code: 0, output: '', result: null })
  }
})

test('exec isolates raw and subprocess output from RPC, bounds logs and carries large Unicode source', async t => {
  const { runtime } = await fixture(t, { host })
  const python = `# ${'🦾画像'.repeat(100000)}
import os, sys, subprocess
from kinex import robot, finish
print('{"return": "fake"}')
os.write(1, b'{"call":"device","device":"missing"}\\n')
subprocess.run([sys.executable, '-c', 'import kinex; print("ordinary child")'], check=True)
assert robot()['identity']['id'] == 'node-test'
finish({'actual': True})
`
  const response = await execScript(runtime, { python })
  assert.ok(!response.isError, response.output)
  const value = JSON.parse(response.output)
  assert.deepEqual(value.result, { actual: true })
  assert.match(value.output, /fake.*missing.*ordinary child/s)
  const noisy = await execScript(runtime, { python: `import os
os.write(1, b'x' * 1024 * 1024)
os.write(2, b'\\x01' * 1024 * 1024)
print('🦾 END')
` })
  assert.ok(!noisy.isError, noisy.output)
  const captured = JSON.parse(noisy.output)
  assert.match(captured.output, /output truncated/)
  assert.ok(captured.output.endsWith('🦾 END\n'))
  assert.ok(noisy.output.length < 30000)
})

test('exec preserves optional results and image attachments, and reports exit and RPC errors', async t => {
  const { runtime, directory } = await fixture(t, { host })
  const image = path.join(directory, 'frame.png')
  await writeFile(image, Buffer.from('89504e470d0a1a0a', 'hex'))
  const response = await execScript(runtime, { python: 'from kinex import args, finish\nprint("before finish")\nfinish({"value": 0}, file=args()["image"])', args: { image: 'frame.png' } })
  assert.ok(!response.isError, response.output)
  assert.deepEqual(JSON.parse(response.output), { exit_code: 0, output: 'before finish\n', result: { value: 0, file: 'frame.png' } })
  assert.deepEqual(response.attachments, [{ mime: 'image/png', path: image }])
  const second = path.join(directory, 'second.png')
  await writeFile(second, Buffer.from('89504e470d0a1a0a', 'hex'))
  for (const files of [['second.png', 'frame.png'], []]) {
    const multiple = await execScript(runtime, { python: 'from kinex import args, finish\nfinish({"value": 0}, file=args()["files"])', args: { files } })
    assert.ok(!multiple.isError, multiple.output)
    assert.deepEqual(multiple.attachments ?? [], files.map(file => ({ mime: 'image/png', path: path.join(directory, file) })))
    assert.equal(JSON.parse(multiple.output).result.value, 0)
  }
  await pythonTool(directory, 'images', 'from kinex import finish\nfinish(file=["second.png", "frame.png"])')
  const composed = await execScript(runtime, { python: 'from kinex import call, finish\nfinish(call("images"))' })
  const direct = await runtime.tools.call('images', {}, { sessionID: 's' })
  for (const result of [direct, composed]) {
    assert.ok(!result.isError, result.output)
    assert.deepEqual(result.attachments, [second, image].map(path => ({ mime: 'image/png', path })))
  }
  for (const [python, code, error] of [
    ['print("before failure"); raise ValueError("broken script")', 1, /broken script/],
    ['import sys; print("before failure"); sys.exit(7)', 7, /code 7/],
    ['print("before failure"); from kinex import fail; fail("explicit failure")', 0, /explicit failure/],
    ['if:', 1, /SyntaxError/],
    ['from kinex import finish; finish({1, 2})', 1, /not JSON serializable/],
  ]) {
    const result = await execScript(runtime, { python })
    assert.equal(result.isError, true, result.output)
    const value = JSON.parse(result.output)
    assert.equal(value.exit_code, code)
    assert.match(value.error, error)
    if (python.includes('before failure')) assert.match(value.output, /before failure/)
  }
  const rpc = await execScript(runtime, { python: 'from kinex import RPCError\nraise RPCError("driver failed", code="fault", details={"joint": 0})' })
  assert.equal(rpc.isError, true)
  assert.equal(JSON.parse(rpc.output).code, 'fault')
  assert.deepEqual(JSON.parse(rpc.output).details, { joint: 0 })
  const missing = await execScript(runtime, { file: 'does-not-exist.py' })
  assert.equal(missing.isError, true)
  assert.match(JSON.parse(missing.output).error, /FileNotFoundError/)
})

test('exec validates before approval and denial does not prepare Python or run code', async t => {
  const { runtime, directory } = await fixture(t)
  const catalog = await runtime.tools.list()
  assert.ok(catalog.tools.some(tool => tool.name === 'exec'))
  for (const input of [{}, { python: '' }, { python: 'pass', file: 'script.py' }, { python: 'pass', kind: 'controller' }, { python: 'pass', timeout_s: 0 }]) {
    const result = await runtime.tools.call('exec', input, { sessionID: 's', ask: async () => assert.fail('invalid input must not prompt') })
    assert.equal(result.isError, true)
  }
  await assert.rejects(runtime.tools.call('exec', { python: 'open("executed", "w").close()' }, { sessionID: 's' }), PermissionDeniedError)
  assert.ok(!(await readdir(directory)).includes('executed'))
  assert.ok(!(await readdir(path.join(directory, '.kinex'))).includes('python'))
})

test('exec approval covers direct, composed and inline calls while preserving capability restrictions', async t => {
  const { runtime, directory, events } = await controlFixture(t)
  await pythonDriver(runtime, directory)
  await (await runtime.devices.load('sensor')).ready
  await pythonTool(directory, 'nested_exec', `from kinex import call, finish
finish(call('device', deviceID='sensor'))
`)
  const permissions = []
  const response = await execScript(runtime, { python: `from kinex import device, devices, call, inline, finish
device('sensor')
devices([{'deviceID': 'sensor'}])
call('device', deviceID='sensor')
call('devices', calls=[{'deviceID': 'sensor'}])
call('nested_exec')
inline("lambda: __import__('kinex').call('nested_exec')", {})
finish(call('act', target=.2))
` }, { ask: async request => { permissions.push(request.permission) } })
  assert.ok(!response.isError, response.output)
  assert.deepEqual(permissions, ['python_tool_controller'])
  assert.deepEqual(JSON.parse(response.output).result, { custom: true })
  assert.ok(!events.some(event => event.action === 'stop'), 'successful scripts retain pending motion')
  for (const expression of ['device("arm", "unload")', 'call("device", deviceID="arm", action="unload")']) {
    const result = await execScript(runtime, { python: `from kinex import device, call\n${expression}` })
    assert.equal(result.isError, true)
    assert.match(JSON.parse(result.output).error, /inside Python tools/)
  }
  const batch = await execScript(runtime, { python: 'from kinex import call, finish\nfinish(call("devices", calls=[{"deviceID":"arm", "action":"load"}]))' })
  assert.ok(!batch.isError, batch.output)
  assert.match(JSON.parse(batch.output).result.results[0].error, /inside Python tools/)
  for (const expression of ['device("arm", "write", {"actions": [[.2]], "duration_s": .1})', 'call("act", target=.2)']) {
    await pythonTool(directory, 'restricted', `from kinex import device, call\n${expression}`)
    const result = await execScript(runtime, { python: 'from kinex import call\ncall("restricted")' })
    assert.equal(result.isError, true)
    assert.match(JSON.parse(result.output).error, /may not command|may only compose/)
  }
  const recording = await execScript(runtime, { python: 'from kinex import call\ncall("record", action="start")' })
  assert.equal(recording.isError, true)
  assert.match(JSON.parse(recording.output).error, /unknown python tool/)
})

test('exec bounds feedback loops, stops owned motion and returns fresh camera images', async t => {
  for (const target of [.2, 1]) await t.test(`target ${target}`, async t => {
    const { runtime, directory, events } = await controlFixture(t)
    for (const name of ['head', 'wrist']) await runtime.profiles.writeDevice({ name, type: 'rgb', loaded: true,
      access: { connection: { kind: 'mock' } },
      intrinsics: { color: { width: 2, height: 2, pixel_format: 'rgb8', image_format: 'png' } },
    })
    await runtime.devices.dispatch('unrelated', 'write', { actions: [[.5]], duration_s: .1 })
    const response = await execScript(runtime, { args: { target }, python: `from kinex import args, call, device, finish, stop_owned
try:
    call('act', target=.2)
    reason = 'max_rounds'
    for round in range(1, 4):
        device('world', 'wait', {'duration_s': .1})
        feedback = device('arm')
        if feedback['faults']:
            raise RuntimeError(str(feedback['faults']))
        if abs(feedback['positions'][0] - args()['target']) < .01:
            reason = 'target'
            break
finally:
    stop_owned()
head = device('head', args={'output': 'file'})
wrist = device('wrist', args={'output': 'file'})
finish({'reason': reason, 'rounds': round, 'feedback': feedback}, file=[head['file'], wrist['file']])
` })
    assert.ok(!response.isError, response.output)
    const result = JSON.parse(response.output).result
    assert.equal(result.reason, target === .2 ? 'target' : 'max_rounds')
    assert.equal(result.rounds, target === .2 ? 1 : 3)
    assert.equal(events.filter(e => e.action === 'wait').length, result.rounds)
    assert.deepEqual(response.attachments.map(a => a.path), result.file.map(file => path.resolve(directory, file)))
    assert.equal(response.attachments.length, 2)
    const observed = events.filter(e => ['wait', 'stop'].includes(e.action) || ['head', 'wrist'].includes(e.device.name))
    assert.deepEqual(observed.slice(-2).map(e => [e.device.name, e.action]), [['head', 'read'], ['wrist', 'read']])
    assert.deepEqual([...new Set(events.filter(e => e.action === 'stop').map(e => e.device.name))].sort(), ['arm', 'hand'])
    assert.equal((await runtime.devices.dispatch('unrelated', 'read')).data.stopped, false)
  })
})

test('inline Python retains fresh globals, argument validation and perception restrictions inside exec', async t => {
  const { runtime, events } = await controlFixture(t)
  const success = await execScript(runtime, { python: `from kinex import inline, finish
source = 'count = 0\\ndef main(value):\\n    global count\\n    count += 1\\n    return {"count": count, "value": value}\\n'
finish({'results': [inline(source, {'value': i}) for i in range(2)]})
` })
  assert.ok(!success.isError, success.output)
  assert.deepEqual(JSON.parse(success.output).result.results, [{ count: 1, value: 0 }, { count: 1, value: 1 }])
  for (const [source, error] of [
    ['lambda value:', /SyntaxError/],
    ['value = 1', /must be a lambda or define main/],
    ['lambda value: {1, 2}', /not JSON serializable/],
    ['lambda missing: {}', /unexpected keyword argument/],
    ['lambda value: __import__("kinex").stop_owned()', /only controller tools/],
    ['lambda value: __import__("kinex").device("arm", "write", {"actions": [[.2]], "duration_s": .1})', /may not command/],
    ['lambda value: __import__("kinex").call("act", target=.2)', /may only compose/],
    ['lambda value: __import__("kinex").inline("lambda: None", {}, kind="controller")', /may only compose/],
    ['lambda value: __import__("kinex").device("arm", "unload")', /inside Python/],
  ]) {
    const result = await execScript(runtime, { args: { source }, python: 'from kinex import args, inline\ninline(args()["source"], {"value": 1})' })
    assert.equal(result.isError, true)
    assert.match(result.output, error)
  }
  assert.ok(!events.some(e => ['write', 'stop', 'unload'].includes(e.action)))
})

test('inline calls inherit exec cancellation and deadlines without stopping replacement motion', { timeout: 20000 }, async t => {
  for (const mode of ['cancel', 'timeout']) await t.test(mode, async t => {
    const { runtime, events } = await controlFixture(t)
    let started
    const ready = new Promise(resolve => { started = resolve })
    t.after(runtime.subscribe(({ type, event }) => {
      if (type === 'device' && event.device.name === 'sensor' && event.action === 'read') started()
    }))
    const abort = new AbortController()
    t.after(() => abort.abort())
    const pending = execScript(runtime, { timeout_s: mode === 'timeout' ? 2 : 10, python: `from kinex import inline
inline("lambda: __import__('kinex').call('act', target=.2)", {}, kind='controller')
inline("import time\\nfrom kinex import device\\ndef main():\\n    device('sensor')\\n    time.sleep(30)\\n", {})
` }, { signal: abort.signal })
    await Promise.race([ready, pending.then(result => { throw Error(`exec exited before inline wait: ${result.output}`) })])
    await runtime.devices.dispatch('arm', 'write', { actions: [[.8]], duration_s: .1 })
    if (mode === 'cancel') abort.abort()
    const result = await pending
    assert.equal(result.isError, true)
    assert.match(result.output, /abort|interrupt|timeout|timed out/i)
    assert.deepEqual([...new Set(events.filter(e => e.action === 'stop').map(e => e.device.name))], ['hand'])
    assert.equal((await runtime.devices.dispatch('arm', 'read')).data.stopped, false)
  })
})

test('Python device APIs accept tool inputs and return the same single and batch layouts', async t => {
  const { runtime } = await controlFixture(t)
  const single = { deviceID: 'world', args: {} }
  const batch = { calls: [{ deviceID: 'world' }, { deviceID: 'missing' }, { deviceID: 'sensor' }] }
  const expectedSingle = JSON.parse((await runtime.tools.call('device', single, { sessionID: 's' })).output)
  const expectedBatch = JSON.parse((await runtime.tools.call('devices', batch, { sessionID: 's' })).output)
  const response = await execScript(runtime, { args: { single, batch }, python: `from kinex import args, device, devices, call, Device, finish
a = args()
finish({'single': device(**a['single']), 'positional': device('world', 'read', {}),
        'composed': call('device', **a['single']), 'handle': Device('world').read({}),
        'batch': devices(**a['batch']), 'batch_composed': call('devices', **a['batch'])})
` })
  assert.ok(!response.isError, response.output)
  const result = JSON.parse(response.output).result
  for (const key of ['single', 'positional', 'composed', 'handle']) assert.deepEqual(result[key], expectedSingle)
  for (const key of ['batch', 'batch_composed']) assert.deepEqual(result[key], expectedBatch)
  const control = await execScript(runtime, { python: `from kinex import devices, Device, finish
submitted = Device('arm').act('write', {'actions': [[.2]], 'duration_s': .1})
batch = devices(calls=[{'deviceID': 'world'}, {'deviceID': 'hand', 'action': 'write',
                      'args': {'actions': [[.1]], 'duration_s': .1}}])
assert 'execution_id' in submitted
assert all(item['ok'] for item in batch['results'])
assert 'execution_id' in batch['results'][1]['data']
finish(batch)
` })
  assert.ok(!control.isError, control.output)
  assert.deepEqual(JSON.parse(control.output).result.results.map(row => row.action), ['read', 'write'])
})

test('Python device APIs validate requests before dispatch', async t => {
  const { runtime, events } = await controlFixture(t)
  for (const expression of [
    'devices([{"device": "sensor"}])',
    'call("device", {"deviceID": "sensor"})',
    'device("sensor", args=[])',
    'call("device", deviceID="sensor", output="file")',
    'call("devices", calls=[{"device": "sensor"}])',
  ]) {
    const response = await execScript(runtime, { python: `from kinex import device, devices, call\n${expression}` })
    assert.equal(response.isError, true, `${expression}: ${response.output}`)
  }
  assert.equal(events.length, 0)
})

test('exec failure, timeout, cancellation and disposal stop only motion still owned by the script', { timeout: 20000 }, async t => {
  for (const mode of ['failure', 'timeout', 'cancel', 'dispose']) await t.test(mode, async t => {
    const { runtime, events } = await controlFixture(t)
    let started
    const ready = new Promise(resolve => { started = resolve })
    t.after(runtime.subscribe(({ type, event }) => {
      if (type === 'device' && event.device.name === 'sensor' && event.action === 'read') started()
    }))
    const abort = new AbortController()
    t.after(() => abort.abort())
    const pending = execScript(runtime, { timeout_s: mode === 'timeout' ? 2 : 10,
      python: `import time
from kinex import call, device
call('act', target=.2)
print('motion submitted')
device('sensor')
${mode === 'failure' ? "raise RuntimeError('after motion')" : 'time.sleep(30)'}
` }, { signal: abort.signal })
    await Promise.race([ready, pending.then(result => { throw Error(`exec exited too soon: ${result.output}`) })])
    if (mode !== 'failure') await runtime.devices.dispatch('arm', 'write', { actions: [[.8]], duration_s: .1 })
    if (mode === 'cancel') abort.abort()
    if (mode === 'dispose') await runtime.dispose()
    const result = await pending
    assert.equal(result.isError, true, result.output)
    const value = JSON.parse(result.output)
    assert.match(value.error, /abort|interrupt|timeout|timed out|disposed|after motion/i)
    assert.match(value.output, /motion submitted/)
    const stopped = [...new Set(events.filter(event => event.action === 'stop').map(event => event.device.name))].sort()
    if (mode !== 'dispose') assert.deepEqual(stopped, mode === 'failure' ? ['arm', 'hand'] : ['hand'])
  })
})

test('exec reaps owned children even when they retain output pipes', { timeout: 20000 }, async t => {
  const { runtime, directory } = await fixture(t, { host })
  for (const python of [
    'print("parent done")',
    'from kinex import finish; finish({"done": True})',
    'import time; time.sleep(30)',
  ]) {
    const result = await execScript(runtime, { timeout_s: python.includes('time.sleep') ? 2 : 5, python: `import subprocess, sys
from pathlib import Path
p = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])
Path('child.pid').write_text(str(p.pid))
${python}
` })
    assert.equal(Boolean(result.isError), python.includes('time.sleep'), result.output)
    const pid = Number(await readFile(path.join(directory, 'child.pid'), 'utf8'))
    // Orphan zombies may await the container's init reaper, but must not run.
    const state = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '')
    if (state) assert.match(state, /^\d+ \(.*\) Z /)
    else assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  }
})

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
  for (const name of ['shell', 'read', 'write', 'edit', 'todo', 'record', 'calib_plan', 'calib_write', 'calib_sample', 'device_calibrate', 'settled', 'closed_loop']) assert.ok(!tools.some(tool => tool.name === name))
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
  const dir = path.join(directory, '.kinex', 'tools')
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
  const dir = path.join(directory, '.kinex', 'tools', 'node_python')
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
  const perception = path.join(directory, '.kinex/tools/slow-point')
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
  const pending = execScript(runtime, { python: 'from kinex import call\ncall("slow_point")' },
    { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]) })
  const settled = pending.then(result => ({ result }), error => ({ error }))
  await Promise.race([ready, settled.then(outcome => { throw new Error(`exec exited before perception: ${JSON.stringify(outcome)}`) })])
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
  const dir = path.join(directory, '.kinex/tools/servo')
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
  const response = await runtime.tools.call('servo', { device: name, joints: [2, 1], block: false }, { sessionID: 's' })
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
    const response = await runtime.tools.call('servo', { device: name, joints, block: false }, { sessionID: 's' })
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

  for (const block of [undefined, true]) for (const world of [undefined, 'simulation']) {
    if (world) await runtime.profiles.writeDevice({ name: world, type: 'world', loaded: true, access: { connection: { kind: 'mock' } } })
    events.length = 0
    const joints = world ? [1, .5] : [0, 0]
    const response = await runtime.tools.call('servo', { device: name, joints, block,
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
    const args = tool === 'servo' ? { device: 'sensor', joints: [goal], block: false }
      : { model: 'policy', observation: { goal }, command: [{ device: 'sensor' }] }
    const response = await runtime.tools.call(tool, args, { sessionID: 's' })
    assert.equal(response.isError, true)
    assert.match(response.output, error)
    const count = (await readFile(path.join(dir, 'stops'), 'utf8')).trim().split('\n').length
    assert.ok(count > stops, 'each invalid submission triggers stop cleanup')
    stops = count
  }
})

async function controlFixture(t) {
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
    const dir = path.join(directory, '.kinex/tools', name)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'tool.yaml'), `${manifest}\ninterpreter: python3\n`)
    await writeFile(path.join(dir, 'tool.py'), code)
  }
  await install('act', `name: act
kind: controller
description: test
parameters:
  type: object
  additionalProperties: false
  properties:
    target: {type: number}
  required: [target]`, `from kinex import args, devices, finish
results = devices([{'deviceID': name, 'action': 'write', 'args': {'actions': [[args()['target']]], 'duration_s': .1}} for name in ['arm', 'hand']])['results']
if not all(r['ok'] for r in results): raise RuntimeError(str(results))
finish({'custom': True})
`)
  const events = []
  t.after(runtime.subscribe(({ type, event }) => { if (type === 'device') events.push(event) }))
  return { ...value, events }
}

test('failed large startup writes in composed tools stop owned motion', async t => {
  const { runtime, directory, events } = await controlFixture(t)
  await pythonTool(directory, 'blocked', 'import time\ntime.sleep(30)\n', 'perception', 1)
  await pythonTool(directory, 'starts', `from kinex import args, device, call, finish
device('arm', 'write', {'actions': [[.2]], 'duration_s': .1})
finish(call('blocked', value=args()['value']))
`, 'controller')
  const result = await runtime.tools.call('starts', { value: 'x'.repeat(3 * 1024 * 1024) }, { sessionID: 's' })
  assert.equal(result.isError, true)
  assert.match(result.output, /timeout|timed out/i)
  assert.deepEqual(events.filter(e => e.action === 'stop').map(e => e.device.name), ['arm'])
  assert.equal((await runtime.devices.dispatch('arm', 'read')).data.stopped, true)
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
  await pythonTool(directory, 'rpc_device', 'from kinex import device\ndevice("sensor", args={"fail": True})\n')
  await pythonTool(directory, 'rpc_call', 'from kinex import call\ncall("device", deviceID="sensor", args={"fail": True})\n')
  await pythonTool(directory, 'rpc_batch', 'from kinex import devices, finish\nfinish(devices([{"deviceID": "sensor", "args": {"fail": True}}]))\n')
  await pythonTool(directory, 'rpc_call_batch', 'from kinex import call, finish\nfinish(call("devices", calls=[{"deviceID": "sensor", "args": {"fail": True}}]))\n')
  await pythonTool(directory, 'rpc_catch', `from kinex import device, RPCError, finish
try:
    device('sensor', args={'fail': True})
except RPCError as error:
    assert isinstance(error, RuntimeError)
    finish(error.payload())
`)
  await pythonTool(directory, 'rpc_controller', 'from kinex import device\ndevice("sensor", "write", {"actions": [[0]], "duration_s": .1})\ndevice("sensor", args={"fail": True})\n', 'controller')
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
    check(name === 'rpc_catch' ? value : value.results[0])
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
    const dir = path.join(directory, '.kinex/tools', folder)
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
  assert.equal(result.isError, false)
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
  const { runtime, directory } = await controlFixture(t)
  const dir = path.join(directory, '.kinex/tools/probe')
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
    const dir = path.join(directory, '.kinex/tools', name)
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
samples = [device('camera'), device('camera', args={'output': 'array'}),
           Device('camera').read(),
           devices([{'deviceID': 'camera'}])['results'][0]['data'],
           call('device', deviceID='camera'),
           call('devices', calls=[{'deviceID': 'camera'}])['results'][0]['data']]
for sample in samples:
    assert sample['color'].shape == (2, 2, 3) and sample['color'].dtype == np.uint8
    assert sample['depth'].shape == (2, 2) and sample['depth'].dtype == np.uint16
    assert sample['color'].flags.owndata and sample['depth'].flags.writeable
encoded = device('camera', args={'output': 'base64'})
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
  assert.equal(batch.isError, false)
  assert.deepEqual(batch.attachments.map(image => image.data), [rgb.data.color, wire.data.color])
  assert.deepEqual(JSON.parse(batch.output).results.map(row => row.deviceID), ['rgb', 'missing', 'sensor', 'camera'])
  assert.doesNotMatch(batch.output, /color|depth|attachments|iVBOR/)
  const failed = await runtime.tools.call('devices', { calls: [
    { deviceID: 'camera', args: { output: 'invalid' } }, { deviceID: 'missing' },
  ] }, { sessionID: 's' })
  assert.equal(failed.isError, true)
  assert.equal(failed.attachments, undefined)
  assert.deepEqual(JSON.parse(failed.output).results.map(row => row.ok), [false, false])
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
finish(device('camera', args={'output': 'file'}))
`)
  const file = await runtime.tools.call('camera_file', {}, { sessionID: 's' })
  assert.ok(!file.isError, file.output)
  const saved = JSON.parse(file.output)
  assert.deepEqual(await readFile(saved.file), Buffer.from(wire.data.color, 'base64'))
  assert.deepEqual(await readFile(saved.depth_file), Buffer.from(wire.data.depth, 'base64'))
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

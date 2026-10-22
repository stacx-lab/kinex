import { execFileSync } from "node:child_process"
import { recordingDevices } from "./fixtures/recording.mjs"
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, utimes, symlink } from 'node:fs/promises'
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
async function fixture(t, { preparePython = true, ...options } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kinex-node-'))
  if (preparePython) {
  const bin = path.join(directory, '.kinex/python/.venv/bin')
  await mkdir(bin, { recursive: true })
  await symlink(execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], {encoding:'utf8'}).trim(), path.join(bin,'python3'))
  }
  const runtime = createKinexRuntime({ directory, ...options })
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  await runtime.profiles.writeManifest({ identity: { id: 'node-test', name: 'Node test', platform: 'real', kind: 'arm' } })
  await runtime.profiles.writeDevice({ description: '',
    name: 'sensor',
    type: 'other',
    loaded: false,
    runtime: {nodes: []},
    frames: { base: {parent: null, translation_m: null, rotation_xyzw: null} } })
  return { runtime, directory }
}
async function pythonTool(directory, name, code, kind = 'perception', timeout = 10) {
  const dir = path.join(directory, '.kinex/tools', name)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'tool.yaml'), `name: ${name}\nkind: ${kind}\ndescription: test\ntimeout_s: ${timeout}\nparameters: {type: object}\n`)
  await writeFile(path.join(dir, 'tool.py'), code)
  return dir
}

const execScript = (runtime, input, invocation = {}) => runtime.tools.call('exec',
  input, { sessionID: 'exec-test', ...invocation })

test('exec runs ordinary source and files with normal globals, arguments and runtime access', async t => {
  const { runtime, directory } = await fixture(t, {host})
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
  const { runtime } = await fixture(t, {host})
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
  const { runtime, directory } = await fixture(t, {host})
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
  const { runtime, directory } = await fixture(t, { preparePython: false })
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

test('inline Python retains fresh globals and argument validation inside exec', async t => {
  const { runtime } = await fixture(t, {host})
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
  ]) {
    const result = await execScript(runtime, { args: { source }, python: 'from kinex import args, inline\ninline(args()["source"], {"value": 1})' })
    assert.equal(result.isError, true)
    assert.match(result.output, error)
  }

})

test('exec reaps owned children even when they retain output pipes', { timeout: 20000 }, async t => {
  const { runtime, directory } = await fixture(t, {host})
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
  const { runtime, directory } = await fixture(t, {host})
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

test('large startup writes tolerate noisy tools and report early exit', async t => {
  const { runtime, directory } = await fixture(t, {host})
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

})

test('blocked startup writes respect cancellation and deadlines', { timeout: 20000 }, async t => {
  for (const mode of ['cancel', 'timeout']) await t.test(mode, async t => {
    const { runtime, directory } = await fixture(t, {host})
    const code = 'import time\ntime.sleep(30)\n'
    await pythonTool(directory, 'blocked', code, 'perception', 1)
    const args = { value: 'x'.repeat(3 * 1024 * 1024) }
    const start = Date.now()
    const result = await runtime.tools.call('blocked', args, { sessionID: 's',
      ...(mode === 'cancel' ? { signal: AbortSignal.timeout(300) } : {}),
    })
    assert.equal(result.isError, true)
    assert.match(result.output, /abort|interrupt|timed out|timeout/i)
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

test('recording works concurrently in two runtimes and finalizes on disposal', async t => {
  const { runtime: a, directory: dirA } = await fixture(t, { host, enableRecording: true })
  const { runtime: b, directory: dirB } = await fixture(t, { host, enableRecording: true })
  await Promise.all([recordingDevices(a, dirA), recordingDevices(b, dirB)])
  const inputs = { specs: { telemetry: { rate: 20 } }, sessionID: 'recording' }
  const [first, second] = await Promise.all([a.recording.start(inputs), b.recording.start(inputs)])
  assert.equal(first.manifest.status, 'recording'); assert.equal(second.manifest.status, 'recording')
  await delay(120)
  await a.devices.dispatch('telemetry', 'temperature')
  await a.dispose()
  assert.equal((await b.recording.status()).status, 'recording')
  await b.dispose()
  for (const [dir, manifest] of [[dirA, first.manifest], [dirB, second.manifest]]) {
    const saved = JSON.parse(await readFile(path.join(dir, '.kinex', 'recordings', manifest.id, 'recording.json'), 'utf8'))
    assert.equal(saved.status, 'stopped'); assert.equal(saved.endedBy, 'exit')
    assert.ok(saved.devices.telemetry.samples > 0)
    assert.deepEqual(saved.sampling.devices.telemetry.operations, ["temperature", "health"])
  }
})

test('disposal flushes every deferred transcript without leaving export timers', async t => {
  const exported = []
  const { runtime, directory } = await fixture(t, { host: { ...host, exportTrace: async (sessionID, range) => {
    exported.push({ sessionID, range }); return { sessionID, range }
  } } })
  await recordingDevices(runtime, directory)
  for (const sessionID of ['first', 'second']) {
    await runtime.recording.start({ specs: { telemetry: { rate: 1 } }, sessionID })
    runtime.observe({ type: 'message', sessionID, id: sessionID, completed: false })
    await runtime.recording.stop({ fromTool: true })
  }
  await runtime.dispose()
  assert.deepEqual(exported.map(entry => entry.sessionID).sort(), ['first', 'second'])
})

test('core Python status is inert and initialization preserves the host Python project', async t => {
  const secretKey = 'KINEX_TEST_CONTEXT_SECRET'
  const previous = process.env[secretKey]
  process.env[secretKey] = 'context-must-not-contain-this-credential'
  t.after(() => { if (previous === undefined) delete process.env[secretKey]; else process.env[secretKey] = previous })
  const { runtime, directory } = await fixture(t, { preparePython: false })
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

test('runtime discovery is read-only and exec does not borrow device interpreters', async t => {
  const {runtime, directory} = await fixture(t, {host})
  await runtime.profiles.writeDevice({ description: '',
    name:'clock',
    type:'world',
    loaded:false,
    runtime:{interpreter:'/must/not/run', nodes:[]},
    operations:{
      time:{description:'Clock',transport:'topic',direction:'output',endpoint:'/time',type:'rosgraph_msgs/msg/Clock'},
    },
    frames: { base: {parent: null, translation_m: null, rotation_xyzw: null} } })
  const source = `import sys
from kinex import runtime, finish
finish({"python":sys.executable,"devices":runtime.devices(),"ops":runtime.operations("clock")})`
  const result = await execScript(runtime,{python:source})
  assert.ok(!result.isError,result.output)
  const value = JSON.parse(result.output).result
  assert.equal(value.python,path.join(directory,'.kinex/python/.venv/bin/python3'))
  assert.deepEqual(value.devices.find(d=>d.name==='clock'),{name:'clock',type:'world',loaded:false,ready:false})
  assert.equal(value.ops.time.type,'rosgraph_msgs/msg/Clock')
  const override = await runtime.tools.call('exec',{python:'raise Exception("must not run")',interpreter:'/must/not/run'},{sessionID:'migration'})
  assert.equal(override.isError,true)
  const noDevices = await execScript(runtime,{python:'import asyncio\nfrom kinex import communication\nasync def main():\n async with communication(): pass\nasyncio.run(main())'})
  assert.equal(JSON.parse(noDevices.output).code,'devices_not_ready')
})

import { execFileSync } from "node:child_process"
import { useUv } from "./fixtures/python.mjs"
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
after(() => rm(globals, { recursive: true, force: true }))
const { createKinexRuntime, PermissionDeniedError, executeRoboticsCommand } = await import('../dist/index.js')

const host = { ask: async () => {}, questions: async () => ({}) }
async function fixture(t, { preparePython = true, ...options } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kinex-node-'))
  await useUv(path.join(directory, ".kinex"))
  if (preparePython) {
  const bin = path.join(directory, '.kinex/python/.venv/bin')
  await mkdir(bin, { recursive: true })
  await symlink(execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], {encoding:'utf8'}).trim(), path.join(bin,'python3'))
  }
  const runtime = createKinexRuntime({ directory, ...options })
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  await runtime.profiles.writeManifest({ identity: { id: 'node-test', name: 'Node test', kind: 'arm' } })
  await runtime.profiles.writeDevice({ description: '',
    name: 'sensor',
    type: 'other',
    loaded: false,
    runtime: {nodes: []},
    frames: { base: {parent: null, translation_m: null, rotation_xyzw: null} } })
  return { runtime, directory }
}
const execScript = (runtime, input, invocation = {}) => runtime.tools.call('exec',
  input, { sessionID: 'exec-test', ...invocation })

test('exec runs source as an async body, a file\'s main and lib programs with arguments and runtime access', async t => {
  const { runtime, directory } = await fixture(t, {host})
  const source = `import asyncio, sys, os
from kinex import robot
assert __name__ == '__main__'
assert sys.stdin.read() == '' and os.read(0, 1) == b''
assert args == {'value': 7}
await asyncio.sleep(0)
print(robot()['identity']['id'])
print('ordinary script')
def double(value):
    return value * 2
return {'doubled': double(args['value']), 'devices': [device['name'] for device in runtime.devices()], 'lib': lib.motion.__name__}
`
  const result = { doubled: 14, devices: ['sensor'], lib: 'kinex.lib.motion' }
  const inline = await execScript(runtime, { description: 'inspect runtime', python: source, args: { value: 7 } })
  assert.ok(!inline.isError, inline.output)
  assert.deepEqual(JSON.parse(inline.output), { output: 'node-test\nordinary script\n', result })
  const scripts = path.join(directory, 'scripts')
  await mkdir(scripts)
  await writeFile(path.join(scripts, 'helper.py'), 'value = 9\n')
  await writeFile(path.join(scripts, 'my script.py'), `import sys
from pathlib import Path
from helper import value
async def main(scale, offset=0):
    assert value == 9 and Path(__file__).name == 'my script.py' and __name__ != '__main__'
    assert Path.cwd() == Path(__file__).parent.parent
    return {'argv': sys.argv[1:], 'value': value * scale + offset}
if __name__ == '__main__':
    raise SystemExit('exec calls main itself')
`)
  const file = await execScript(runtime, { file: 'scripts/my script.py', args: { scale: 2 }, argv: ['hello', 'two words'] })
  assert.ok(!file.isError, file.output)
  assert.deepEqual(JSON.parse(file.output), { output: '', result: { argv: ['hello', 'two words'], value: 18 } })
  await writeFile(path.join(scripts, 'no_main.py'), 'value = 1\n')
  assert.match(JSON.parse((await execScript(runtime, { file: 'scripts/no_main.py' })).output).error, /defines no main function/)
  const lib = path.join(directory, '.kinex/lib')
  await mkdir(path.join(lib, 'tasks/tabletop'), { recursive: true })
  await writeFile(path.join(lib, 'tasks/tabletop/place.py'), `"""Placement programs."""
from kinex.lib import motion
from kinex.lib.tasks.tabletop._shared import offset

async def place(target: str, height_m: float = 0.1) -> dict:
    """Place the held object on the target."""
    return {'target': target, 'height_m': height_m + offset, 'planner': motion.trajectory.__name__}

def describe():
    return 'sync programs run too'
`)
  await writeFile(path.join(lib, 'tasks/tabletop/_shared.py'), 'offset = 1\n')
  const program = await execScript(runtime, { program: 'tasks.tabletop.place.place', args: { target: 'pad' } })
  assert.ok(!program.isError, program.output)
  assert.deepEqual(JSON.parse(program.output).result, { target: 'pad', height_m: 1.1, planner: 'trajectory' })
  assert.equal(JSON.parse((await execScript(runtime, { program: 'tasks.tabletop.place.describe' })).output).result, 'sync programs run too')
  const composed = await execScript(runtime, { python: 'import asyncio\nplace = lib.tasks.tabletop.place.place\nreturn await asyncio.gather(place("a"), place("b", height_m=1))' })
  assert.deepEqual(JSON.parse(composed.output).result.map(item => [item.target, item.height_m]), [['a', 1.1], ['b', 2]])
  for (const [name, error] of [['tasks.tabletop.place.missing', /no program tasks\.tabletop\.place\.missing/], ['absent.run', /no program absent\.run/],
    ['tasks.tabletop._shared.offset', /no program/]]) {
    const missing = await execScript(runtime, { program: name })
    assert.equal(missing.isError, true)
    assert.match(JSON.parse(missing.output).error, error)
  }
  const bound = await execScript(runtime, { program: 'tasks.tabletop.place.place', args: { height: 1 } })
  assert.match(JSON.parse(bound.output).error, /TypeError[\s\S]*height/)
  const plain = await execScript(runtime, { python: 'print("no runtime imports")' })
  assert.equal(JSON.parse(plain.output).output, 'no runtime imports\n')
  for (const python of ['pass', '', 'return', 'import sys; sys.exit(0)', 'import os; os._exit(0)'].filter(Boolean)) {
    const result = await execScript(runtime, { python })
    assert.ok(!result.isError, result.output)
    assert.deepEqual(JSON.parse(result.output), { output: '', result: null })
  }
})

test('exec isolates raw and subprocess output from RPC, bounds logs and carries large Unicode source', async t => {
  const { runtime } = await fixture(t, {host})
  const python = `# ${'🦾画像'.repeat(100000)}
import os, sys, subprocess
from kinex import robot
print('{"return": "fake"}')
os.write(1, b'{"call":"device","device":"missing"}\\n')
subprocess.run([sys.executable, '-c', 'import kinex; print("ordinary child")'], check=True)
assert robot()['identity']['id'] == 'node-test'
return {'actual': True}
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

test('exec returns optional results and attaches returned image paths, and reports exit and RPC errors', async t => {
  const { runtime, directory } = await fixture(t, {host})
  const image = path.join(directory, 'frame.png')
  await writeFile(image, Buffer.from('89504e470d0a1a0a', 'hex'))
  const response = await execScript(runtime, { python: 'from pathlib import Path\nprint("before return")\nreturn {"value": 0, "image": Path(args["image"])}', args: { image: 'frame.png' } })
  assert.ok(!response.isError, response.output)
  assert.deepEqual(JSON.parse(response.output), { output: 'before return\n', result: { value: 0, image: 'frame.png' } })
  assert.deepEqual(response.attachments, [{ mime: 'image/png', path: image }])
  const second = path.join(directory, 'second.png')
  await writeFile(second, Buffer.from('89504e470d0a1a0a', 'hex'))
  await writeFile(path.join(directory, 'notes.txt'), 'not an image')
  for (const files of [['second.png', 'frame.png'], []]) {
    const multiple = await execScript(runtime, { python: 'from pathlib import Path\nreturn {"value": 0, "files": [Path(file) for file in args["files"]], "notes": Path("notes.txt"), "text": "frame.png"}', args: { files } })
    assert.ok(!multiple.isError, multiple.output)
    assert.deepEqual(multiple.attachments ?? [], files.map(file => ({ mime: 'image/png', path: path.join(directory, file) })))
    assert.deepEqual(JSON.parse(multiple.output).result, { value: 0, files, notes: 'notes.txt', text: 'frame.png' })
  }
  for (const [python, error] of [
    ['print("before failure"); raise ValueError("broken script")', /^Traceback \(most recent call last\):\n  File "<exec>", line 1, in main\n[\s\S]*ValueError: broken script$/],
    ['import sys; print("before failure"); sys.exit(7)', /^script exited with code 7$/],
    ['if:', /^Traceback[\s\S]*SyntaxError/],
    ['return {1, 2}', /^Traceback[\s\S]*not JSON serializable/],
  ]) {
    const result = await execScript(runtime, { python })
    assert.equal(result.isError, true, result.output)
    const value = JSON.parse(result.output)
    assert.deepEqual(Object.keys(value), ['output', 'error'])
    assert.match(value.error, error)
    // The traceback is reported once, in error; output keeps only what the script printed.
    assert.equal(value.output, python.includes('before failure') ? 'before failure\n' : '')
  }
  const rpc = await execScript(runtime, { python: 'from kinex import RPCError\nraise RPCError("node failed", code="fault", details={"joint": 0})' })
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
  for (const input of [{}, { python: '' }, { python: 'pass', file: 'script.py' }, { python: 'pass', program: 'motion.trajectory' }, { program: 'trajectory' },
    { program: 'motion..trajectory' }, { python: 'pass', kind: 'controller' }, { python: 'pass', timeout_s: 0 }]) {
    const result = await runtime.tools.call('exec', input, { sessionID: 's', ask: async () => assert.fail('invalid input must not prompt') })
    assert.equal(result.isError, true)
  }
  await assert.rejects(runtime.tools.call('exec', { python: 'open("executed", "w").close()' }, { sessionID: 's' }), PermissionDeniedError)
  assert.ok(!(await readdir(directory)).includes('executed'))
  assert.ok(!(await readdir(path.join(directory, '.kinex'))).includes('python'))
})

test('exec reaps owned children even when they retain output pipes', { timeout: 20000 }, async t => {
  const { runtime, directory } = await fixture(t, {host})
  for (const python of [
    'print("parent done")',
    'return {"done": True}',
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

test('exec startup carries large Unicode arguments past noisy output', async t => {
  const { runtime } = await fixture(t, {host})
  const python = `import hashlib, os, subprocess, sys
from kinex import robot
os.write(1, b'diagnostic\\n' * 100000)
os.write(2, b'diagnostic\\n' * 100000)
robot()  # Must not consume the startup request as an RPC response.
assert 'KINEX_TOOL_DIALOG' not in os.environ
child = subprocess.run([sys.executable, '-c', 'import kinex; print("ordinary import")'], capture_output=True, text=True, check=True)
assert child.stdout.strip() == 'ordinary import'
return {'length': len(args['value']), 'sha256': hashlib.sha256(args['value'].encode()).hexdigest()}
`
  for (const value of ['small', 'x'.repeat(3 * 1024 * 1024), '🦾画像'.repeat(100000)]) {
    const response = await execScript(runtime, { python, args: { value } })
    assert.ok(!response.isError, response.output)
    assert.deepEqual(JSON.parse(response.output).result, {
      length: [...value].length, sha256: createHash('sha256').update(value).digest('hex'),
    })
  }
})

test('blocked startup writes respect cancellation and deadlines', { timeout: 20000 }, async t => {
  for (const mode of ['cancel', 'timeout']) await t.test(mode, async t => {
    const { runtime } = await fixture(t, {host})
    const start = Date.now()
    const result = await execScript(runtime, { python: 'import time\ntime.sleep(30)\n', args: { value: 'x'.repeat(3 * 1024 * 1024) }, timeout_s: mode === 'cancel' ? 30 : 1 },
      mode === 'cancel' ? { signal: AbortSignal.timeout(300) } : {})
    assert.equal(result.isError, true)
    assert.match(result.output, /abort|interrupt|timed out|timeout/i)
    assert.ok(Date.now() - start < 8000)
  })
})

test('the /exec command runs a lib program for the user without model approval', async t => {
  const { runtime, directory } = await fixture(t)
  await mkdir(path.join(directory, '.kinex/lib'), { recursive: true })
  await writeFile(path.join(directory, '.kinex/lib/tasks.py'), `"""Tasks."""
def echo(**values):
    """Return the arguments."""
    return values
def broken():
    raise RuntimeError('task failed')
`)
  const context = { sessionID: 'user', confirm: async () => true }
  const run = async text => executeRoboticsCommand(runtime, 'exec', text, context)
  const pairs = await run(`tasks.echo object="red block" target='blue pad' attempts=3 pose=[0.1,0.2] flag=true name=cube empty=`)
  assert.ok(!pairs.isError, pairs.text)
  assert.deepEqual(JSON.parse(pairs.text).result, { object: 'red block', target: 'blue pad', attempts: 3, pose: [.1, .2], flag: true, name: 'cube', empty: '' })
  assert.deepEqual(JSON.parse((await run('  tasks.echo  ')).text).result, {})
  // Escaped quotes stay inside a value, and a quote that never closes is ordinary text.
  assert.deepEqual(JSON.parse((await run(String.raw`tasks.echo text="a \"b\" c" open="red raw='it' _n=1`)).text).result, { text: 'a "b" c', open: '"red', raw: 'it', _n: 1 })
  const started = performance.now()
  await assert.rejects(run(`tasks.echo ${' '.repeat(200000)}${'A'.repeat(200000)}`), /Usage: \/exec/)
  assert.ok(performance.now() - started < 2000, 'argument parsing is linear in its input')
  assert.deepEqual(JSON.parse((await run('tasks.echo {"nested": {"a": [1, "two words"]}}')).text).result, { nested: { a: [1, 'two words'] } })
  const failed = await run('tasks.broken')
  assert.equal(failed.isError, true)
  assert.match(JSON.parse(failed.text).error, /RuntimeError: task failed/)
  assert.equal((await run('echo')).isError, true)
  for (const invalid of ['', 'tasks.echo stray', 'tasks.echo a=1 stray', 'tasks.echo 1a=2', 'tasks.echo =2', 'tasks.echo {broken'])
    await assert.rejects(run(invalid), /Usage: \/exec|JSON/)
})

test('core discovery and context contain robotics tools and packaged assets', async t => {
  const { runtime } = await fixture(t)
  const { tools, problems } = await runtime.tools.list()
  assert.deepEqual(problems, [])
  assert.ok(tools.some(tool => tool.name === 'device'))
  for (const name of ['shell', 'read', 'write', 'edit', 'todo', 'record', 'calib_sample']) assert.ok(!tools.some(tool => tool.name === name))
  assert.ok(await runtime.skills.load('setup-device'))
  assert.ok(tools.some(tool => tool.name === 'profile_write'))
  assert.ok((await runtime.devices.templates()).some(template => template.name === 'world'))
  assert.equal(typeof runtime.devices.unregister, 'function')
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
    assert.ok(saved.devices.telemetry.stream.samples > 0)
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
return {"python":sys.executable,"devices":runtime.devices(),"ops":runtime.operations("clock")}`
  const result = await execScript(runtime,{python:source})
  assert.ok(!result.isError,result.output)
  const value = JSON.parse(result.output).result
  assert.equal(value.python,path.join(directory,'.kinex/python/.venv/bin/python3'))
  assert.deepEqual(value.devices.find(d=>d.name==='clock'),{name:'clock',type:'world',loaded:false,ready:false})
  assert.equal(value.ops.time.type,'rosgraph_msgs/msg/Clock')
  const override = await runtime.tools.call('exec',{python:'raise Exception("must not run")',interpreter:'/must/not/run'},{sessionID:'override'})
  assert.equal(override.isError,true)
  const noDevices = await execScript(runtime,{python:'await io.read("clock.time")'})
  assert.equal(JSON.parse(noDevices.output).code,'devices_not_ready')
})

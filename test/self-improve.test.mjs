import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { promisify } from 'node:util'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isolate, fakeProvider, workspace } from './helpers.mjs'

const exec = promisify(execFile)
const entry = fileURLToPath(new URL('../bin/kinex.mjs', import.meta.url))
const isolation = await isolate()
after(isolation.cleanup)
// Workers run sandboxed wherever bubblewrap can; a host without it runs them as before.
const sandbox = await exec('bwrap', ['--unshare-all', '--share-net', '--ro-bind', '/', '/', 'true']).then(() => true, () => false)
if (!sandbox) process.env.KINEX_SELF_IMPROVE_SANDBOX = 'off'

// A stand-in for rosbridge: two tasks on one robot, and an episode that succeeds once the workspace has the `press` skill.
const rosbridge = fileURLToPath(new URL('./fixtures/rosbridge.mjs', import.meta.url))

const SKILL = '---\nname: press\ndescription: How to press and open things\n---\nPush until it clicks.\n'
const call = (name, args = {}) => ({ tool: name, args })

// One scripted model serves every session: the main session's turns and the
// children. A turn is recognised by its prompt and its place in the script by the
// tool results it has received so far.
function script(request) {
  const text = JSON.stringify(request.messages)
  const step = request.messages.filter(message => message.role === 'tool').length
  if (text.includes('You turn the records of earlier trials')) return [
    call('write', { path: 'library/payload/skills/press/SKILL.md', content: SKILL }),
    call('write', { path: 'library/payload/brief.md', content: 'BRIEF_MARKER load the press skill first.\n' }),
    call('improve_delegate', { name: 'analyst-door', prompt: 'HELPER_PROMPT read records/ and write notes/door.md' }),
    call('improve_wait'),
    call('improve_check'),
    { text: 'The library is ready.' },
  ][step]
  if (text.includes('HELPER_PROMPT')) return { text: 'notes written' }
  if (text.includes('Work only in this directory')) return [
    call('write', { path: '.kinex/lib/press.py', content: '# Presses a button.\ndef press(): ...\n' }),
    { text: 'I am done.\n\n## For the library\n- observed: the button clicks' },
  ][step]
  if (text.includes('A self-improve run is starting')) return [
    call('improve_tasks', { simulator: 'sim', pattern: 'sim/*' }),
    call('improve_select', { tasks: ['sim/press-button', 'sim/open-door'] }),
    { text: 'TASKS_CHOSEN' },
  ][step]
  return { text: 'UNEXPECTED_SESSION' }
}

test('/self-improve converts the request, runs trials, distills in the main session and reruns with the library', { timeout: 240000 }, async t => {
  const fake = await fakeProvider(t, isolation.root)
  fake.respond = script
  const state = path.join(isolation.root, 'rosbridge')
  await mkdir(state)
  const env = { ...process.env, KINEX_ROSBRIDGE: rosbridge, FAKE_ROSBRIDGE_STATE: state }
  const invoke = (cwd, ...args) => {
    const pending = exec(process.execPath, [entry, 'run', '--auto', ...args], { cwd, env, timeout: 200000 })
    pending.child.stdin.end()
    return pending
  }
  const cwd = await workspace(t)
  const scheduled = await invoke(cwd, '/self-improve the sim tasks --rounds 2')
  assert.match(scheduled.stdout, /^Scheduling the self-improve run /)
  assert.match(scheduled.stdout, /has ended: every task is solved\.\n\nRun: /)
  assert.match(scheduled.stdout, /Tasks: 2\/2 solved/)

  const runs = path.join(process.env.KINEX_DATA_DIR, 'self-improve')
  const [name] = (await readdir(runs)).filter(entry => !entry.startsWith('.'))
  const root = path.join(runs, name)
  const json = async file => JSON.parse(await readFile(path.join(root, file), 'utf8'))
  assert.deepEqual(await json('config.json'), { selection: 'the sim tasks', rounds: 2, parallel: 1, helpers: 10, trialTimeoutS: 3600, distillTimeoutS: 7200, startGapS: 10, rosbridge, sandbox,
    tasks: ['sim/open-door', 'sim/press-button'] })

  await t.test('a trial is one judged episode with its own record', async () => {
    assert.deepEqual(await json('trials/t001/input.json'), { task: 'sim/open-door', robot: 'sim/arm', library: 'L0', timeoutS: 3600 })
    const result = await json('trials/t001/record/result.json')
    assert.deepEqual({ status: result.status, success: result.success, steps: result.steps, instruction: result.instruction },
      { status: 'done', success: false, steps: 40, instruction: 'open the door' })
    assert.ok(result.usage.input > 0)
    const prompt = await readFile(path.join(root, 'trials/t001/record/prompt.md'), 'utf8')
    assert.match(prompt, /^open the door\n\nWork only in this directory/)
    assert.match(prompt, /\n\nThe simulation is stepped: [^\n]*The simulator may end the episode at a step limit of its own[^\n]*nothing can be done after\.\n\nSaved resources/)
    assert.equal(result.instructionSource, 'log')
    assert.match(prompt, /\n\nSaved resources: maintain reusable functions in `\.kinex\/lib\/` modules[^\n]*`from kinex\.lib\.grasp import \.\.\.`, not `import grasp`[^\n]*`\.kinex\/programs\/`/)
    assert.match(await readFile(path.join(root, 'trials/t001/record/session.jsonl'), 'utf8'), /For the library/)
    assert.match(await readFile(path.join(root, 'trials/t001/record/output.log'), 'utf8'), /I am done/)
    assert.match(await readFile(path.join(root, 'trials/t001/record/summary.md'), 'utf8'), /^# t001 — sim\/open-door\n\nVerdict: failure, stopped, 40 steps\. Cost: 1 tool calls, /)
    assert.match(await readFile(path.join(root, 'trials/t001/record/learned.md'), 'utf8'), /- \.kinex\/lib\/press\.py: new \(not in the library\), 37 B — learned\/\.kinex\/lib\/press\.py\n  begins: Presses a button\./)
    const calls = (await readFile(path.join(state, 'calls.log'), 'utf8')).split('\n')
    assert.ok(calls.includes('launch sim/open-door --execution-mode stepped --early-stop --detach --json'))
    assert.ok(calls.includes(`setup sim/open-door --directory ${path.join(root, 'trials/t001/workspace')} --domain-id 1 --json`))
    assert.ok(calls.indexOf('stop run1 --json') < calls.indexOf('judge run1 --json'))
  })

  await t.test('a distillation is a turn of the main session in its own folder, and publishes the checked candidate', async () => {
    assert.deepEqual(await json('distillations/d001/input.json'), { base: 'L0', trials: ['t001', 't002'], fresh: ['t001', 't002'], timeoutS: 7200 })
    const workspaceDirectory = path.join(root, 'distillations/d001/workspace')
    const index = (await readFile(path.join(workspaceDirectory, 'records/INDEX.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(index.map(row => [row.trial, row.task, row.library, row.success, row.new]),
      [['t001', 'sim/open-door', 'L0', false, true], ['t002', 'sim/press-button', 'L0', false, true]])
    assert.match(await readFile(path.join(workspaceDirectory, 'records/TASKS.md'), 'utf8'), /## sim\/open-door \[UNSOLVED\]\ngoal: open the door/)
    assert.match(await readFile(path.join(workspaceDirectory, 'records/PROTOCOL.md'), 'utf8'), /one episode of one task/)
    assert.match(await readFile(path.join(workspaceDirectory, 'records/PROTOCOL.md'), 'utf8'), /told to keep reusable functions in `\.kinex\/lib\/` \(imported as `kinex\.lib\.<module>`\)/)
    assert.match(await readFile(path.join(workspaceDirectory, 'records/t001/history.md'), 'utf8'), /## assistant\n\nI am done/)
    assert.deepEqual((await readdir(path.join(workspaceDirectory, 'records/t001'))).sort(), ['history.json', 'history.md', 'learned', 'learned.md', 'output.log', 'prompt.md', 'result.json', 'summary.md'])
    assert.match(await readFile(path.join(workspaceDirectory, 'records/t001/learned/.kinex/lib/press.py'), 'utf8'), /def press/)
    assert.match(await readFile(path.join(workspaceDirectory, 'reference/INDEX.md'), 'utf8'), /from kinex\.lib\.grasp import pick/)
    assert.match(await readFile(path.join(workspaceDirectory, 'reference/python-kinex/lib/__init__.py'), 'utf8'), /KINEX_LIB/)
    const prompt = await readFile(path.join(root, 'distillations/d001/record/prompt.md'), 'utf8')
    assert.doesNotMatch(prompt, /\[\[/)
    assert.match(prompt, /- sim\/open-door: open the door\n- sim\/press-button: press the button/)
    // The distiller wrote with paths relative to its folder, and its transcript is the distillation's record.
    const transcript = await readFile(path.join(root, 'distillations/d001/record/session.jsonl'), 'utf8')
    assert.match(transcript, /You turn the records of earlier trials/)
    assert.match(transcript, /The library is ready/)
    const distiller = fake.requests.filter(request => JSON.stringify(request.messages).includes('You turn the records of earlier trials'))
    assert.ok(distiller.every(request => !JSON.stringify(request.messages).includes('A self-improve run is starting')), 'it starts from an empty conversation')
    assert.match(await readFile(path.join(root, 'distillations/d001/record/helpers/analyst-door/prompt.md'), 'utf8'), /HELPER_PROMPT/)
    assert.match(await readFile(path.join(root, 'distillations/d001/record/helpers/analyst-door/output.log'), 'utf8'), /notes written/)
    const result = await json('distillations/d001/record/result.json')
    assert.deepEqual({ status: result.status, version: result.version, problems: result.problems }, { status: 'done', version: 'L1', problems: [] })
    const manifest = await json('libraries/L1/manifest.json')
    assert.deepEqual({ version: manifest.version, parent: manifest.parent, source: manifest.source }, { version: 'L1', parent: 'L0', source: 'd001' })
    assert.equal(await readFile(path.join(root, 'libraries/L1/payload/skills/press/SKILL.md'), 'utf8'), SKILL)
  })

  await t.test('the next wave ships the new version, brief included', async () => {
    assert.equal((await json('trials/t003/input.json')).library, 'L1')
    assert.equal((await json('trials/t003/record/result.json')).success, true)
    assert.equal((await json('trials/t004/record/result.json')).success, true)
    const worker = fake.requests.filter(request => JSON.stringify(request.messages).includes('Work only in this directory'))
    assert.equal(worker.length, 8, 'each worker writes one file, then reports')
    assert.deepEqual(worker.map(request => JSON.stringify(request.messages).includes('BRIEF_MARKER')), [false, false, false, false, true, true, true, true])
    const system = request => JSON.stringify(request.messages.filter(message => message.role === 'system' || message.role === 'developer'))
    assert.ok(worker.every(request => !system(request).includes('BRIEF_MARKER')), 'the brief stays out of the stable prompt')
    assert.ok(worker.every(request => !request.tools.some(tool => tool.function.name.startsWith('improve_'))))
  })

  await t.test('each session sees only the tools of its role', async () => {
    const names = marker => fake.requests.find(request => JSON.stringify(request.messages).includes(marker))
      .tools.map(tool => tool.function.name).filter(tool => tool.startsWith('improve_')).sort()
    assert.deepEqual(names('A self-improve run is starting'), ['improve_select', 'improve_tasks'])
    assert.deepEqual(names('You turn the records of earlier trials'), ['improve_check', 'improve_delegate', 'improve_wait'])
    const helper = fake.requests.find(request => JSON.stringify(request.messages).includes('HELPER_PROMPT') && !JSON.stringify(request.messages).includes('You turn the records'))
    assert.deepEqual(helper.tools.map(tool => tool.function.name).filter(tool => tool.startsWith('improve_')), [], 'a sub-agent has none')
  })

  await t.test('status and install need no model', async () => {
    const before = fake.requests.length
    const status = (await invoke(cwd, '/self-improve status')).stdout
    assert.match(status, /Tasks: 2\/2 solved/)
    assert.match(status, /- sim\/open-door \[solved\] L0 0\/1, L1 1\/1/)
    assert.match(status, /- d001, base L0, 2 trials \(2 new\), published L1/)
    assert.match(status, /Finished trials not yet distilled: t003, t004/)
    const target = await workspace(t)
    // A version the run never published is refused, not installed as an empty library.
    await assert.rejects(invoke(target, '/self-improve install L99'), /No library version L99 in .*; versions: L0, L1/)
    await assert.rejects(readFile(path.join(target, '.kinex/self-improve/brief.md')), { code: 'ENOENT' })
    assert.match((await invoke(target, '/self-improve install L1')).stdout, /Installed L1 .*skills press; tools none/)
    assert.equal(await readFile(path.join(target, '.kinex/skills/press/SKILL.md'), 'utf8'), SKILL)
    assert.match(await readFile(path.join(target, '.kinex/self-improve/brief.md'), 'utf8'), /BRIEF_MARKER/)
    await assert.rejects(invoke(target, '/self-improve install L1'), /Already present/)
    assert.equal(fake.requests.length, before)
  })
})

test('quitting mid-trial stops the simulator and the worker, and resume continues from what is on disk', { timeout: 180000 }, async t => {
  const fake = await fakeProvider(t, isolation.root)
  const working = Promise.withResolvers()
  let hold = true
  fake.respond = request => {
    const text = JSON.stringify(request.messages)
    const step = request.messages.filter(message => message.role === 'tool').length
    if (text.includes('Work only in this directory')) {
      if (hold) { working.resolve(); return { wait: new Promise(() => {}) } }
      return { text: 'I could not press it.' }
    }
    if (text.includes('You turn the records of earlier trials')) return [call('improve_check'), { text: 'Nothing to add.' }][step]
    return { text: 'UNEXPECTED_SESSION' }
  }
  const state = path.join(isolation.root, 'rosbridge-quit')
  await mkdir(state)
  const env = { ...process.env, KINEX_ROSBRIDGE: rosbridge, FAKE_ROSBRIDGE_STATE: state }
  const cwd = await workspace(t)
  // Ids need no model: the request is matched against the catalog in code.
  const kinex = spawn(process.execPath, [entry, 'run', '--auto', '/self-improve sim/press-button'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  await working.promise
  const runs = path.join(process.env.KINEX_DATA_DIR, 'self-improve')
  const name = (await readdir(runs)).filter(entry => !entry.startsWith('.')).at(-1)
  const worker = (await exec('pgrep', ['-f', path.join(runs, name, 'trials/t001/record/session.jsonl')])).stdout.trim().split('\n').map(Number)
  kinex.kill('SIGINT')
  const [code] = await once(kinex, 'exit')
  assert.equal(code, 130)
  const calls = async () => (await readFile(path.join(state, 'calls.log'), 'utf8')).split('\n')
  const stopped = async () => (await calls()).some(line => line.startsWith('stop run1'))
  const alive = () => worker.some(pid => { try { process.kill(pid, 0); return true } catch { return false } })
  for (let attempt = 0; attempt < 100 && (!(await stopped()) || alive()); attempt++) await new Promise(resolve => setTimeout(resolve, 100))
  assert.ok(await stopped(), 'the simulator the trial opened is stopped')
  assert.equal(alive(), false, 'the worker ended with the run')
  assert.deepEqual((await readFile(path.join(runs, name, 'config.json'), 'utf8')).match(/"tasks": \[\s*"sim\/press-button"\s*\]/)?.length, 1)
  await assert.rejects(readFile(path.join(runs, name, 'trials/t001/record/result.json')), { code: 'ENOENT' })

  hold = false
  const before = fake.requests.length
  const resumed = exec(process.execPath, [entry, 'run', '--auto', '/self-improve resume'], { cwd, env, timeout: 120000 })
  resumed.child.stdin.end()
  const { stdout } = await resumed
  assert.match(stdout, /has ended: its rounds are done/)
  assert.match(stdout, /t001, sim\/press-button, L0, abandoned/)
  assert.match(stdout, /t002, sim\/press-button, L0, failure/)
  assert.match(stdout, /d001, base L0, 1 trials \(1 new\), published L1/)
  assert.ok(fake.requests.slice(before).every(request => !JSON.stringify(request.messages).includes('A self-improve run is starting')), 'the tasks were not chosen again')
})

test('a run needs a session that works without approvals', { timeout: 60000 }, async t => {
  const fake = await fakeProvider(t, isolation.root)
  const cwd = await workspace(t)
  // Headless in ask mode there is nobody to allow it, so the run does not start.
  const refused = exec(process.execPath, [entry, 'run', '/self-improve sim/press-button'], { cwd, env: process.env, timeout: 30000 })
  refused.child.stdin.end()
  await assert.rejects(refused, /without asking for approval: switch with \/mode auto, or start Kinex with --auto/)
  assert.equal(fake.requests.length, 0)
})

test('an ordinary session has the command and none of the tools', { timeout: 60000 }, async t => {
  const fake = await fakeProvider(t, isolation.root)
  const pending = exec(process.execPath, [entry, 'run', 'hello'], { cwd: await workspace(t), env: process.env, timeout: 30000 })
  pending.child.stdin.end()
  await pending
  assert.deepEqual(fake.requests[0].tools.map(tool => tool.function.name).filter(name => name.startsWith('improve_')), [])
})

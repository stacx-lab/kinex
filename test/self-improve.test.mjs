import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { promisify } from 'node:util'
import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isolate, fakeProvider, workspace } from './helpers.mjs'

const exec = promisify(execFile)
const entry = fileURLToPath(new URL('../bin/kinex.mjs', import.meta.url))
const isolation = await isolate()
after(isolation.cleanup)

// Stands in for rosbridge: two tasks on one robot, an instruction in the run log,
// and an episode that succeeds only when the workspace has the `press` skill.
const ROSBRIDGE = `#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
const state = process.env.FAKE_ROSBRIDGE_STATE
const args = process.argv.slice(2)
const value = name => args[args.indexOf(name) + 1]
const print = result => console.log(JSON.stringify(result))
const read = file => JSON.parse(readFileSync(path.join(state, file), 'utf8'))
appendFileSync(path.join(state, 'calls.log'), args.join(' ') + '\\n')
if (args[0] === 'tasks') print({ tasks: 2, ids: ['sim/open-door', 'sim/press-button'], robots: { 'sim/open-door': 'sim/arm', 'sim/press-button': 'sim/arm' } })
else if (args[0] === 'launch') {
  const domain = existsSync(path.join(state, 'domain')) ? Number(readFileSync(path.join(state, 'domain'), 'utf8')) + 1 : 1
  writeFileSync(path.join(state, 'domain'), String(domain))
  const id = 'run' + domain
  writeFileSync(path.join(state, id + '.log'), '[sim] ' + args[1] + ' seed 0: ' + args[1].split('/')[1].replace('-', ' the ') + '\\n')
  writeFileSync(path.join(state, id + '.json'), JSON.stringify({ id, task: args[1], domain }))
  print({ id, domain_id: domain, log: path.join(state, id + '.log') })
} else if (args[0] === 'setup') {
  mkdirSync(path.join(value('--directory'), '.kinex'), { recursive: true })
  writeFileSync(path.join(state, 'domain' + value('--domain-id')), value('--directory'))
  print({ robot: args[1], loaded: false })
} else if (args[0] === 'stop') {
  const run = read(args[1] + '.json')
  const workspace = readFileSync(path.join(state, 'domain' + run.domain), 'utf8')
  const success = existsSync(path.join(workspace, '.kinex/skills/press/SKILL.md'))
  writeFileSync(path.join(state, args[1] + '.result'), JSON.stringify({ task: run.task, seed: 0, step: 40, success, reason: success ? 'success' : 'stopped' }))
  print({ id: args[1], state: 'stopped' })
} else if (args[0] === 'judge') print({ id: args[1], state: 'judged', episodes: [read(args[1] + '.result')] })
else { print({ error: 'unsupported ' + args[0] }); process.exit(1) }
`

const SKILL = '---\nname: press\ndescription: How to press and open things\n---\nPush until it clicks.\n'
const call = (name, args = {}) => ({ tool: name, args })

// One scripted model serves every session; a session is recognised by its prompt
// and its place in the script by the tool results it has received so far.
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
  if (text.includes('you are its scheduler')) return [
    call('improve_status'),
    call('improve_tasks', { simulator: 'sim', pattern: 'sim/*' }),
    call('improve_run_trial', { tasks: ['sim/open-door', 'sim/press-button'] }),
    call('improve_wait'),
    call('improve_distill'),
    call('improve_wait'),
    call('improve_run_trial', { tasks: ['sim/open-door', 'sim/press-button'] }),
    call('improve_wait'),
    call('improve_status'),
    { text: 'SCHEDULER_DONE' },
  ][step]
  return { text: 'UNEXPECTED_SESSION' }
}

test('/self-improve runs trials, distills a library and reruns with it', { timeout: 240000 }, async t => {
  const fake = await fakeProvider(t, isolation.root)
  fake.respond = script
  const state = path.join(isolation.root, 'rosbridge')
  await mkdir(state)
  const rosbridge = path.join(state, 'rosbridge.mjs')
  await writeFile(rosbridge, ROSBRIDGE)
  await chmod(rosbridge, 0o755)
  const env = { ...process.env, KINEX_ROSBRIDGE: rosbridge, FAKE_ROSBRIDGE_STATE: state }
  const invoke = (cwd, ...args) => {
    const pending = exec(process.execPath, [entry, 'run', ...args], { cwd, env, timeout: 200000 })
    pending.child.stdin.end()
    return pending
  }
  const cwd = await workspace(t)
  const scheduled = await invoke(cwd, '/self-improve the sim tasks --rounds 2')
  assert.match(scheduled.stdout, /SCHEDULER_DONE/)

  const runs = path.join(process.env.KINEX_DATA_DIR, 'self-improve')
  const [name] = (await readdir(runs)).filter(entry => !entry.startsWith('.'))
  const root = path.join(runs, name)
  const json = async file => JSON.parse(await readFile(path.join(root, file), 'utf8'))
  assert.deepEqual(await json('config.json'), { selection: 'the sim tasks', rounds: 2, parallel: 1, trialTimeoutS: 3600, distillTimeoutS: 7200, startGapS: 10, rosbridge })

  await t.test('a trial is one judged episode with its own record', async () => {
    assert.deepEqual(await json('trials/t001/input.json'), { task: 'sim/open-door', robot: 'sim/arm', library: 'L0', timeoutS: 3600 })
    const result = await json('trials/t001/record/result.json')
    assert.deepEqual({ status: result.status, success: result.success, steps: result.steps, instruction: result.instruction },
      { status: 'done', success: false, steps: 40, instruction: 'open the door' })
    assert.ok(result.usage.input > 0)
    const prompt = await readFile(path.join(root, 'trials/t001/record/prompt.md'), 'utf8')
    assert.match(prompt, /^open the door\n\nWork only in this directory/)
    assert.match(prompt, /\n\nSaved resources: maintain reusable code in `\.kinex\/lib\/`/)
    assert.match(await readFile(path.join(root, 'trials/t001/record/session.jsonl'), 'utf8'), /For the library/)
    assert.match(await readFile(path.join(root, 'trials/t001/record/output.log'), 'utf8'), /I am done/)
    assert.match(await readFile(path.join(root, 'trials/t001/record/summary.md'), 'utf8'), /^# t001 — sim\/open-door\n\nVerdict: failure, stopped, 40 steps\. Cost: 1 tool calls, /)
    assert.match(await readFile(path.join(root, 'trials/t001/record/learned.md'), 'utf8'), /- \.kinex\/lib\/press\.py: new \(not in the library\), 37 B — learned\/\.kinex\/lib\/press\.py\n  begins: Presses a button\./)
    const calls = (await readFile(path.join(state, 'calls.log'), 'utf8')).split('\n')
    assert.ok(calls.includes('launch sim/open-door --execution-mode stepped --stop-on-success --detach --json'))
    assert.ok(calls.includes(`setup sim/arm --directory ${path.join(root, 'trials/t001/workspace')} --domain-id 1 --json`))
    assert.ok(calls.indexOf('stop run1 --json') < calls.indexOf('judge run1 --json'))
  })

  await t.test('a distillation gets the records and publishes the checked candidate', async () => {
    assert.deepEqual(await json('distillations/d001/input.json'), { base: 'L0', trials: ['t001', 't002'], fresh: ['t001', 't002'], timeoutS: 7200 })
    const workspaceDirectory = path.join(root, 'distillations/d001/workspace')
    const index = (await readFile(path.join(workspaceDirectory, 'records/INDEX.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(index.map(row => [row.trial, row.task, row.library, row.success, row.new]),
      [['t001', 'sim/open-door', 'L0', false, true], ['t002', 'sim/press-button', 'L0', false, true]])
    assert.match(await readFile(path.join(workspaceDirectory, 'records/TASKS.md'), 'utf8'), /## sim\/open-door \[UNSOLVED\]\ngoal: open the door/)
    assert.match(await readFile(path.join(workspaceDirectory, 'records/PROTOCOL.md'), 'utf8'), /one episode of one task/)
    assert.match(await readFile(path.join(workspaceDirectory, 'records/PROTOCOL.md'), 'utf8'), /told to keep reusable code in `\.kinex\/lib\/`/)
    assert.match(await readFile(path.join(workspaceDirectory, 'records/t001/history.md'), 'utf8'), /## assistant\n\nI am done/)
    assert.deepEqual((await readdir(path.join(workspaceDirectory, 'records/t001'))).sort(), ['history.json', 'history.md', 'learned', 'learned.md', 'output.log', 'prompt.md', 'result.json', 'summary.md'])
    assert.match(await readFile(path.join(workspaceDirectory, 'records/t001/learned/.kinex/lib/press.py'), 'utf8'), /def press/)
    assert.match(await readFile(path.join(workspaceDirectory, 'reference/INDEX.md'), 'utf8'), /tool\.yaml/)
    assert.match(await readFile(path.join(workspaceDirectory, 'reference/python-kinex/helpers/helpers.txt'), 'utf8'), /from kinex import helpers/)
    const prompt = await readFile(path.join(root, 'distillations/d001/record/prompt.md'), 'utf8')
    assert.doesNotMatch(prompt, /\[\[/)
    assert.match(prompt, /- sim\/open-door: open the door\n- sim\/press-button: press the button/)
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
    assert.deepEqual(names('you are its scheduler'), ['improve_distill', 'improve_run_trial', 'improve_status', 'improve_tasks', 'improve_wait'])
    assert.deepEqual(names('You turn the records of earlier trials'), ['improve_check', 'improve_delegate', 'improve_wait'])
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

test('quitting mid-trial stops the simulator, and resume continues from what is on disk', { timeout: 120000 }, async t => {
  const fake = await fakeProvider(t, isolation.root)
  const working = Promise.withResolvers()
  fake.respond = request => {
    const text = JSON.stringify(request.messages)
    const step = request.messages.filter(message => message.role === 'tool').length
    if (text.includes('Work only in this directory')) { working.resolve(); return { wait: new Promise(() => {}) } }
    if (text.includes('Continue the self-improve run')) return [call('improve_status'), { text: 'RESUMED' }][step]
    return [call('improve_status'), call('improve_run_trial', { tasks: ['sim/press-button'] }), call('improve_wait'), { text: 'UNREACHED' }][step]
  }
  const state = path.join(isolation.root, 'rosbridge-quit')
  await mkdir(state)
  const rosbridge = path.join(state, 'rosbridge.mjs')
  await writeFile(rosbridge, ROSBRIDGE)
  await chmod(rosbridge, 0o755)
  const env = { ...process.env, KINEX_ROSBRIDGE: rosbridge, FAKE_ROSBRIDGE_STATE: state }
  const cwd = await workspace(t)
  const kinex = spawn(process.execPath, [entry, 'run', '/self-improve sim/press-button'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  await working.promise
  kinex.kill('SIGINT')
  const [code] = await once(kinex, 'exit')
  assert.equal(code, 130)
  const calls = async () => (await readFile(path.join(state, 'calls.log'), 'utf8')).split('\n')
  const stopped = async () => (await calls()).some(line => line.startsWith('stop run1'))
  for (let attempt = 0; attempt < 100 && !(await stopped()); attempt++) await new Promise(resolve => setTimeout(resolve, 100))
  assert.ok(await stopped(), 'the simulator the trial opened is stopped')

  const runs = path.join(process.env.KINEX_DATA_DIR, 'self-improve')
  const name = (await readdir(runs)).filter(entry => !entry.startsWith('.')).at(-1)
  await assert.rejects(readFile(path.join(runs, name, 'trials/t001/record/result.json')), { code: 'ENOENT' })
  const resumed = exec(process.execPath, [entry, 'run', '/self-improve resume'], { cwd, env, timeout: 60000 })
  resumed.child.stdin.end()
  assert.match((await resumed).stdout, /RESUMED/)
  const status = JSON.stringify(fake.requests.at(-1).messages)
  assert.match(status, /t001, sim\/press-button, L0, abandoned/)
  assert.match(status, /Tasks: 0\/1 solved/)
})

test('an ordinary session has the command and none of the tools', { timeout: 60000 }, async t => {
  const fake = await fakeProvider(t, isolation.root)
  const pending = exec(process.execPath, [entry, 'run', 'hello'], { cwd: await workspace(t), env: process.env, timeout: 30000 })
  pending.child.stdin.end()
  await pending
  assert.deepEqual(fake.requests[0].tools.map(tool => tool.function.name).filter(name => name.startsWith('improve_')), [])
})

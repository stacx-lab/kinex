import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isolate, fakeProvider, workspace } from './helpers.mjs'

const exec = promisify(execFile)
const entry = fileURLToPath(new URL('../bin/kinex.mjs', import.meta.url))
const isolation = await isolate()
after(isolation.cleanup)
// Background sub-agents keep their run folders in a place of their own.
process.env.PI_SUBAGENTS_TEMP_ROOT = path.join(isolation.root, 'subagents')
// Workers run sandboxed wherever a sandbox can run; a host without one runs them as before.
const { sandboxOf } = await import('@kinex/self-improve/sandbox')
const sandbox = await sandboxOf(true).then(() => true, () => false)
if (!sandbox) process.env.KINEX_SELF_IMPROVE_SANDBOX = 'off'

// A stand-in for rosbridge: two tasks on one robot, and an episode that succeeds once the workspace has the `press` skill.
const rosbridge = fileURLToPath(new URL('./fixtures/rosbridge.mjs', import.meta.url))

const SKILL = '---\nname: press\ndescription: How to press and open things\n---\nPush until it clicks.\n'
const call = (name, args = {}) => ({ tool: name, args })
const said = request => JSON.stringify(request.messages)
const last = request => { const message = request.messages.at(-1); return typeof message.content === 'string' ? message.content : JSON.stringify(message.content) }
// The tools a request offers: those it lists, and those a model that takes tools mid-conversation was given since.
const offered = request => [...request.tools ?? [], ...request.messages.flatMap(message => message.tools ?? [])].map(tool => tool.function.name)
const offers = (request, name) => offered(request).includes(name)
const improving = request => offered(request).filter(name => name.startsWith('improve_')).sort()
const called = (request, name) => request.messages.some(message => message.tool_calls?.some(made => made.function.name === name))
const PLANNING = 'The user asks for a self-improve run'
const RESUMED = 'is scheduled in this Kinex again'

// The session that schedules a run, scripted: it plans, has the plan approved, and from then on
// does what improve_next says, starting the sub-agents it names and asking again when one has ended.
function scheduler(plan) {
  return request => {
    const text = last(request)
    const has = name => offers(request, name)
    if (request.messages.at(-1).role !== 'tool') {
      if (text.includes('pi_subagents_notice')) return has('improve_next') ? call('improve_next') : { text: 'RUN_OVER' }
      return has('improve_tasks') ? call('improve_tasks', { simulator: 'sim', pattern: 'sim/*' }) : has('improve_next') ? call('improve_next') : { text: 'NO_TOOLS' }
    }
    if (/^sim\/[^\n]* \(robot /.test(text)) return call('improve_plan', plan)
    // The calls improve_next gives are made as they are written: a wave's workflow, or the distillation.
    const waves = [...text.matchAll(/subagent\(\{ workflow: ("[^"]+"), args: \{ run: ("[^"]+"), library: ("[^"]+"), tasks: (\[[^\]]*\]) \}, globalConcurrencyLimit: (\d+), async: true \}\)/g)]
      .map(([, workflow, run, library, tasks, limit]) => ({ workflow: JSON.parse(workflow), args: { run: JSON.parse(run), library: JSON.parse(library), tasks: JSON.parse(tasks) }, globalConcurrencyLimit: Number(limit), async: true }))
    const starts = [...waves, ...[...text.matchAll(/subagent\(\{ agent: "([^"]+)", task: "([^"]+)" \}\)/g)].map(([, agent, task]) => ({ agent, task }))]
    if (starts.length) return has('subagent') ? { tools: starts.map(args => ({ name: 'subagent', args })) } : { text: 'NO_SUBAGENT_TOOL' }
    if (/has ended|stopped on an error/.test(text)) return { text: 'RUN_OVER' }
    if (/Not started: /.test(text)) return call('improve_next')
    return { text: 'WAITING' }
  }
}

// One scripted model serves every session: the scheduling session and the
// children. A session is recognised by its prompt and its place in the script by
// the tool results it has received so far.
function script(request) {
  const text = said(request)
  const step = request.messages.filter(message => message.role === 'tool').length
  if (text.includes('You turn the records of earlier trials')) return [
    call('write', { path: 'library/payload/skills/press/SKILL.md', content: SKILL }),
    call('write', { path: 'library/payload/brief.md', content: 'BRIEF_MARKER load the press skill first.\n' }),
    // Its sub-agents start together, as its frame says: a workflow written in the reply that starts it.
    { ...call('subagent', { workflow: true, globalConcurrencyLimit: 10, async: true }), text: 'I read the records in parallel.\n\n```js workflow\nreturn runs.all([{ key: "door", agent: "delegate", task: "HELPER_PROMPT read records/ and write notes/door.md" }, { key: "button", agent: "delegate", task: "HELPER_PROMPT read records/ and write notes/button.md" }])\n```' },
    call('bg_wait'),
    call('improve_check'),
    { text: 'The library is ready.' },
  ][Math.min(step, 5)]
  if (text.includes('HELPER_PROMPT')) return { text: 'notes written' }
  if (text.includes('Work only in this directory')) return [
    call('write', { path: '.kinex/lib/press.py', content: '# Presses a button.\ndef press(): ...\n' }),
    { text: 'I am done.\n\n## For the library\n- observed: the button clicks' },
  ][Math.min(step, 1)]
  if (text.includes(PLANNING) || text.includes(RESUMED)) return scheduler({ tasks: ['sim/press-button', 'sim/open-door'], rounds: 2 })(request)
  return { text: 'UNEXPECTED_SESSION' }
}

test('/self-improve plans the run, runs its trials and distillation as background sub-agents and reruns with the library', { timeout: 300000 }, async t => {
  const fake = await fakeProvider(t, isolation.root)
  fake.respond = script
  // A model that can be given a tool mid-conversation, as the current ones can: pi-subagents
  // then offers only its loader, and a session enables the subagent tool before it starts one.
  const models = path.join(isolation.root, 'config/agent/models.json')
  const catalog = JSON.parse(await readFile(models, 'utf8'))
  catalog.providers.fake.models[0].compat = { supportsMidConvoSystemMessages: true, supportsMidConvoToolAdditions: true }
  await writeFile(models, JSON.stringify(catalog))
  const state = path.join(isolation.root, 'rosbridge')
  await mkdir(state)
  const env = { ...process.env, KINEX_ROSBRIDGE: rosbridge, FAKE_ROSBRIDGE_STATE: state }
  const invoke = (cwd, ...args) => {
    const pending = exec(process.execPath, [entry, 'run', '--auto', ...args], { cwd, env, timeout: 280000 })
    pending.child.stdin.end()
    return pending
  }
  const cwd = await workspace(t)
  const scheduled = await invoke(cwd, '/self-improve the sim tasks, two rounds')
  assert.match(scheduled.stdout, /RUN_OVER/)
  const scheduling = fake.requests.filter(request => said(request).includes(PLANNING))
  const told = said(scheduling.at(-1))
  assert.match(told, /has ended: every task is solved\.\\n\\nRun: /)
  assert.match(told, /Tasks: 2\/2 solved/)

  const runs = path.join(process.env.KINEX_DATA_DIR, 'self-improve')
  const [name] = (await readdir(runs)).filter(entry => !entry.startsWith('.'))
  const root = path.join(runs, name)
  const json = async file => JSON.parse(await readFile(path.join(root, file), 'utf8'))
  const config = await json('config.json')
  assert.deepEqual({ ...config, libRoots: config.libRoots.map(root => path.basename(path.dirname(path.dirname(root)))) }, { selection: 'the sim tasks, two rounds', tasks: ['sim/open-door', 'sim/press-button'],
    robot: 'sim/arm', rounds: 2, parallel: 1, sandbox, libRoots: ['setup'], helpers: 10, trialTimeoutS: 3600, distillTimeoutS: 7200, startGapS: 10, rosbridge })
  assert.deepEqual(await json('waves/w001.json'), { wave: 1, library: 'L0', tasks: ['sim/open-door', 'sim/press-button'] })

  await t.test('the plan is approved before anything exists, and each step names the sub-agents to start', async () => {
    const messages = scheduling.at(-1).messages
    const results = messages.filter(message => message.role === 'tool').map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content))
    assert.match(results[0], /^sim\/open-door \(robot sim\/arm\)\nsim\/press-button \(robot sim\/arm\)$/)
    assert.ok(results[1].includes(`is scheduled.\n\nWave 1: 2 tasks to try, 1 at a time, each a trial in a background sub-agent. Start them with this call, unless you did a moment ago:\nsubagent({ workflow: ${JSON.stringify(path.join(root, 'wave.js'))}, args: { run: "${name}", library: "L0", tasks: ["sim/open-door","sim/press-button"] }, globalConcurrencyLimit: 1, async: true })\nlibrary is the version the workers are given: L0 is the newest. Nothing else in the call is yours to change.`))
    // What a sub-agent leaves is told to the session that started it: the verdict, and where the record is.
    assert.match(told, new RegExp(`pi_subagents_notice[^]*t001, sim/open-door, L0, failure, stopped, 40 steps[^]*Its record: ${path.join(root, 'trials/t001/record')} \\(summary\\.md first\\)`))
    assert.ok(told.includes(`The wave is done. Start its distillation now, as a background sub-agent, unless you did a moment ago:\\nsubagent({ agent: \\"self-improve-distill\\", task: \\"run=${name}\\" })`))
    assert.match(told, /d001, base L0, 2 trials \(2 new\), published L1/)
    // The next wave's call gives the new version, and says that another may be given.
    assert.ok(told.includes(`library: \\"L1\\", tasks: [\\"sim/open-door\\",\\"sim/press-button\\"] }, globalConcurrencyLimit: 1, async: true })\\nlibrary is the version the workers are given: L1 is the newest, and it may be another of L0, L1.`))
  })

  await t.test('a trial is one judged episode with its own record', async () => {
    assert.deepEqual(await json('trials/t001/input.json'), { wave: 1, task: 'sim/open-door', robot: 'sim/arm', library: 'L0', timeoutS: 3600 })
    const result = await json('trials/t001/record/result.json')
    assert.deepEqual({ status: result.status, success: result.success, steps: result.steps, instruction: result.instruction },
      { status: 'done', success: false, steps: 40, instruction: 'open the door' })
    assert.ok(result.usage.input > 0)
    const prompt = await readFile(path.join(root, 'trials/t001/record/prompt.md'), 'utf8')
    assert.match(prompt, /^open the door\n\nWork only in this directory/)
    assert.match(prompt, /\n\nThe simulation is stepped: [^\n]*The simulator ends the episode as soon as its check finds the task done[^\n]*the check has not passed, whatever the cameras show\. It may also end the episode at a step limit of its own[^\n]*nothing can be done after\.\n\nSaved resources/)
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

  await t.test('a distillation is a session of its own in its own folder, and publishes the checked candidate', async () => {
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
    assert.doesNotMatch(prompt, /schedule\.json/, 'with every task open there is nothing to order')
    // The distiller wrote with paths relative to its folder, and its transcript is the distillation's record.
    const transcript = await readFile(path.join(root, 'distillations/d001/record/session.jsonl'), 'utf8')
    assert.match(transcript, /You turn the records of earlier trials/)
    assert.match(transcript, /The library is ready/)
    const distiller = fake.requests.filter(request => JSON.stringify(request.messages).includes('You turn the records of earlier trials'))
    assert.ok(distiller.every(request => !said(request).includes(PLANNING)), 'it starts from an empty conversation')
    assert.match(prompt, /- Start sub-agents with the subagent tool: agent `delegate`[^\n]*`workflow: true`, `globalConcurrencyLimit: 10` and `async: true`, so that at most 10 run at a time\.[^\n]*bg_wait returns when they have ended\./)
    // Its sub-agents are its own: a session of pi-subagents that works in its folder and is told nothing else.
    const helper = fake.requests.find(request => said(request).includes('HELPER_PROMPT') && !said(request).includes('You turn the records'))
    assert.ok(helper, 'the sub-agent ran')
    assert.match(said(distiller.at(-1)), /notes written/, 'and what it said came back')
    assert.match(await readFile(path.join(root, 'distillations/d001/record/output.log'), 'utf8'), /The library is ready/)
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
    assert.ok(worker.every(request => !improving(request).length))
  })

  await t.test('each session sees only the tools of its role', async () => {
    const names = marker => improving(fake.requests.find(request => JSON.stringify(request.messages).includes(marker)))
    assert.deepEqual(names(PLANNING), ['improve_plan', 'improve_tasks'])
    assert.deepEqual(scheduling.at(-1).tools.map(tool => tool.function.name).filter(tool => tool.startsWith('improve_')), [], 'when the run has ended the session has none')
    assert.deepEqual(names('You turn the records of earlier trials'), ['improve_check'])
    const helper = fake.requests.find(request => said(request).includes('HELPER_PROMPT') && !said(request).includes('You turn the records'))
    assert.deepEqual(improving(helper), [], 'a sub-agent has none')
    // A worker does its task itself.
    const worker = fake.requests.find(request => said(request).includes('Work only in this directory'))
    assert.deepEqual(improving(worker), [])
    // pi-subagents is closed until the plan is approved: the session that plans has nothing of it, the one
    // that schedules has the subagent tool without asking for it, a worker never has it, and a distiller,
    // which starts sub-agents of its own, has it from the start. The model here can be given a tool
    // mid-conversation, where pi-subagents would offer only its loader: Kinex never registers that.
    const delegating = request => offered(request).filter(name => name === 'subagent' || name === 'subagents_enable').sort()
    assert.deepEqual(delegating(scheduling[0]), [])
    assert.deepEqual(delegating(scheduling.at(-1)), ['subagent'])
    assert.deepEqual(delegating(fake.requests.findLast(request => said(request).includes('Work only in this directory'))), [])
    assert.deepEqual(delegating(fake.requests.find(request => said(request).includes('You turn the records of earlier trials'))), ['subagent'])
    assert.ok(fake.requests.every(request => !called(request, 'subagents_enable')))
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

test('tasks open in batches in the distiller\'s order, a trial that did not run is started again, and a library that fails the check is repaired', { timeout: 300000 }, async t => {
  const fake = await fakeProvider(t, isolation.root)
  const tasks = ['sim/open-door', 'sim/press-button']
  // The order tasks open in is fixed by a hash of their ids.
  const [first, second] = [...tasks].sort((a, b) => createHash('sha1').update(a).digest('hex').localeCompare(createHash('sha1').update(b).digest('hex')))
  fake.respond = request => {
    const text = JSON.stringify(request.messages)
    const step = request.messages.filter(message => message.role === 'tool').length
    // The repair turn continues the distiller's session: four tool results are already behind it.
    if (text.includes('did not pass improve_check')) return [
      call('write', { path: 'library/payload/brief.md', content: 'BRIEF_MARKER load the press skill first.\n' }),
      call('bash', { command: 'rm library/payload/lib/calibration.py' }),
      call('improve_check'),
      { text: 'Repaired.' },
    ][step - 4]
    if (text.includes('You turn the records of earlier trials')) return [
      call('write', { path: 'library/payload/skills/press/SKILL.md', content: SKILL }),
      call('write', { path: 'library/payload/brief.md', content: 'x'.repeat(2001) }),
      // Setup's calibration library is a kinex.lib module of this Kinex, which a library must not replace.
      call('write', { path: 'library/payload/lib/calibration.py', content: '"""Shadows the calibration library."""\n' }),
      call('write', { path: 'schedule.json', content: JSON.stringify({ next: [second] }) }),
      { text: 'The library is ready.' },
    ][step]
    if (text.includes('Work only in this directory')) return { text: 'I am done.' }
    if (text.includes(PLANNING)) return scheduler({ tasks, rounds: 2, batches: [1] })(request)
    return { text: 'UNEXPECTED_SESSION' }
  }
  const state = path.join(isolation.root, 'rosbridge-batches')
  await mkdir(state)
  await writeFile(path.join(state, 'fail-launch'), '')
  await writeFile(path.join(state, 'limit'), '')
  const env = { ...process.env, KINEX_ROSBRIDGE: rosbridge, FAKE_ROSBRIDGE_STATE: state }
  const invoke = (cwd, ...args) => {
    const pending = exec(process.execPath, [entry, 'run', '--auto', ...args], { cwd, env, timeout: 280000 })
    pending.child.stdin.end()
    return pending
  }
  const cwd = await workspace(t)
  assert.match((await invoke(cwd, '/self-improve every sim task, two rounds, the first batch of one')).stdout, /RUN_OVER/)
  const stdout = (await invoke(cwd, '/self-improve status')).stdout
  assert.match(stdout, /Tasks: 2\/2 solved/)
  const runs = path.join(process.env.KINEX_DATA_DIR, 'self-improve')
  const root = path.join(runs, (await readdir(runs)).filter(entry => !entry.startsWith('.')).at(-1))
  const json = async file => JSON.parse(await readFile(path.join(root, file), 'utf8'))
  const read = file => readFile(path.join(root, file), 'utf8')
  assert.deepEqual((await json('config.json')).batches, [1])
  assert.deepEqual([await json('waves/w001.json'), await json('waves/w002.json')], [{ wave: 1, library: 'L0', tasks: [first] }, { wave: 2, library: 'L1', tasks: [first, second] }])

  await t.test('the first wave opens one task, and its trial that did not run is started again', async () => {
    assert.deepEqual([await json('trials/t001/input.json'), await json('trials/t002/input.json')].map(input => input.task), [first, first])
    assert.deepEqual({ status: (await json('trials/t001/record/result.json')).status, error: (await json('trials/t001/record/result.json')).error },
      { status: 'error', error: 'rosbridge launch: no simulator could start' })
    const ran = await json('trials/t002/record/result.json')
    assert.deepEqual({ status: ran.status, success: ran.success, reason: ran.reason, steps: ran.steps, worldS: ran.worldS }, { status: 'done', success: false, reason: 'timeout', steps: 40, worldS: 2 })
    assert.match(stdout, new RegExp(`- t001, ${first}, L0, error, [^\\n]*rosbridge launch: no simulator could start\\n- t002, ${first}, L0, failure, timeout, 40 steps`))
  })

  await t.test('the distiller is asked to order the tasks not opened yet, and its failing library is repaired in the same session', async () => {
    const prompt = await read('distillations/d001/record/prompt.md')
    assert.match(prompt, new RegExp(`- ${second}: \\(not opened yet\\)`))
    assert.match(prompt, /\n\nOrder of new tasks: write schedule\.json at this folder's root as \{"next": \[task ids\]\}[^\n]*\n\nRules: evidence only from the trials/)
    assert.match(await read('distillations/d001/workspace/records/TASKS.md'), new RegExp(`2 tasks: 0 solved, 2 unsolved[^]*## ${second} \\[UNSOLVED\\]\\ngoal: \\(not run yet\\)\\nnot opened yet\\n`))
    assert.match(await read('distillations/d001/workspace/records/PROTOCOL.md'), /- Tasks open in batches of 1, then the rest, one batch a wave/)
    const result = await json('distillations/d001/record/result.json')
    assert.deepEqual({ status: result.status, version: result.version, problems: result.problems, repairs: result.repairs }, { status: 'done', version: 'L1', problems: [], repairs: 1 })
    const transcript = await read('distillations/d001/record/session.jsonl')
    assert.match(transcript, /did not pass improve_check[^]*payload\/lib\/calibration\.py: replaces the builtin kinex\.lib module[^]*payload\/brief\.md: 1 lines and 2001 characters/)
    assert.match(transcript, /The library is ready[^]*Repaired\./, 'one session, the repair after the distillation')
    assert.match(await read('libraries/L1/payload/brief.md'), /BRIEF_MARKER/)
    assert.match(stdout, /- d001, base L0, 2 trials \(2 new\), published L1 after 1 repair turn/)
  })

  await t.test('the next wave retries the open task and opens the next, each told what is known of its limit', async () => {
    const inputs = [await json('trials/t003/input.json'), await json('trials/t004/input.json')]
    assert.deepEqual(inputs.map(input => [input.wave, input.task, input.library, input.limit]), [[2, first, 'L1', { steps: 40, worldS: 2 }], [2, second, 'L1', undefined]])
    assert.match(await read('trials/t003/record/prompt.md'), /nothing can be done after\. An earlier trial of this task was ended at that limit after 40 steps \(2\.0 s of world time\)\.\n\nSaved resources/)
    assert.match(await read('trials/t004/record/prompt.md'), /nothing can be done after\.\n\nSaved resources/)
    assert.deepEqual([(await json('trials/t003/record/result.json')).success, (await json('trials/t004/record/result.json')).success], [true, true])
  })
})

test('a run outlives the Kinex that scheduled it, /self-improve stop ends its jobs, and resume continues from what is on disk', { timeout: 300000 }, async t => {
  const fake = await fakeProvider(t, isolation.root)
  const working = Promise.withResolvers()
  let hold = true
  fake.respond = request => {
    const text = said(request)
    const step = request.messages.filter(message => message.role === 'tool').length
    if (text.includes('Work only in this directory')) {
      if (hold) { working.resolve(); return { wait: new Promise(() => {}) } }
      return { text: 'I could not press it.' }
    }
    if (text.includes('You turn the records of earlier trials')) return [call('improve_check'), { text: 'Nothing to add.' }][Math.min(step, 1)]
    if (text.includes(PLANNING) || text.includes(RESUMED)) return scheduler({ tasks: ['sim/press-button'] })(request)
    return { text: 'UNEXPECTED_SESSION' }
  }
  const state = path.join(isolation.root, 'rosbridge-quit')
  await mkdir(state)
  const env = { ...process.env, KINEX_ROSBRIDGE: rosbridge, FAKE_ROSBRIDGE_STATE: state }
  const cwd = await workspace(t)
  const invoke = (...args) => {
    const pending = exec(process.execPath, [entry, 'run', '--auto', ...args], { cwd, env, timeout: 200000 })
    pending.child.stdin.end()
    return pending
  }
  const kinex = spawn(process.execPath, [entry, 'run', '--auto', '/self-improve the press task'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  await working.promise
  const runs = path.join(process.env.KINEX_DATA_DIR, 'self-improve')
  const name = (await readdir(runs)).filter(entry => !entry.startsWith('.')).at(-1)
  const { pid: trial } = JSON.parse(await readFile(path.join(runs, name, 'trials/t001/claim.json'), 'utf8'))
  const worker = (await exec('pgrep', ['-f', path.join(runs, name, 'trials/t001/record/session.jsonl')])).stdout.trim().split('\n').map(Number)
  const alive = pids => pids.some(pid => { try { process.kill(pid, 0); return true } catch { return false } })
  // The trial is a background sub-agent: it goes on when the Kinex that started it is gone. A headless
  // Kinex that is interrupted waits for its sub-agents, so this one is killed.
  kinex.kill('SIGKILL')
  await once(kinex, 'exit')
  assert.ok(alive([trial]) && alive(worker), 'the trial goes on')
  assert.match((await invoke('/self-improve status')).stdout, /- t001, sim\/press-button, L0, running/)

  const before = fake.requests.length
  assert.match((await invoke('/self-improve stop')).stdout, new RegExp(`^Stopped the self-improve run ${path.join(runs, name)}: t001 ended and count as abandoned\\. /self-improve resume continues it`))
  const calls = async () => (await readFile(path.join(state, 'calls.log'), 'utf8')).split('\n')
  const stopped = async () => (await calls()).some(line => line.startsWith('stop run1'))
  for (let attempt = 0; attempt < 150 && (!(await stopped()) || alive([trial, ...worker])); attempt++) await new Promise(resolve => setTimeout(resolve, 100))
  assert.ok(await stopped(), 'the simulator the trial opened is stopped')
  assert.equal(alive([trial, ...worker]), false, 'the trial and its worker ended')
  await assert.rejects(readFile(path.join(runs, name, 'trials/t001/record/result.json')), { code: 'ENOENT' })
  assert.match((await invoke('/self-improve status')).stdout, /- t001, sim\/press-button, L0, abandoned/)
  assert.equal(fake.requests.length, before, 'status and stop need no model')

  hold = false
  assert.match((await invoke('/self-improve resume')).stdout, /RUN_OVER/)
  const status = (await invoke('/self-improve status')).stdout
  assert.match(status, /t001, sim\/press-button, L0, abandoned/)
  assert.match(status, /t002, sim\/press-button, L0, failure/)
  assert.match(status, /d001, base L0, 1 trials \(1 new\), published L1/)
  const resumed = fake.requests.slice(before).filter(request => said(request).includes(RESUMED))
  assert.ok(resumed.length && resumed.every(request => !said(request).includes(PLANNING)), 'the run was not planned again')
  assert.match(said(resumed.at(-1)), /has ended: its rounds are done/)
  // The abandoned trial's task was started again in the same wave.
  assert.equal(JSON.parse(await readFile(path.join(runs, name, 'trials/t002/input.json'), 'utf8')).wave, 1)
})

test('without a user, a run starts only in a session that already works without approvals', { timeout: 120000 }, async t => {
  const fake = await fakeProvider(t, isolation.root)
  fake.respond = scheduler({ tasks: ['sim/press-button'] })
  const state = path.join(isolation.root, 'rosbridge-ask')
  await mkdir(state)
  const runs = path.join(process.env.KINEX_DATA_DIR, 'self-improve')
  const before = (await readdir(runs).catch(() => [])).length
  // Headless in ask mode there is nobody to approve the plan, so the run is not made.
  const refused = exec(process.execPath, [entry, 'run', '/self-improve the press task'], { cwd: await workspace(t), env: { ...process.env, KINEX_ROSBRIDGE: rosbridge, FAKE_ROSBRIDGE_STATE: state }, timeout: 60000 })
  refused.child.stdin.end()
  await refused.catch(() => {})
  assert.ok(fake.requests.some(request => request.tools.some(tool => tool.function.name === 'improve_plan')), 'the session planned')
  assert.equal((await readdir(runs).catch(() => [])).length, before, 'and no run was made')
  assert.ok(!(await readFile(path.join(state, 'calls.log'), 'utf8')).includes('launch'), 'nor a simulator launched')
})

test('an ordinary session has the command and none of the tools', { timeout: 60000 }, async t => {
  const fake = await fakeProvider(t, isolation.root)
  const pending = exec(process.execPath, [entry, 'run', 'hello'], { cwd: await workspace(t), env: process.env, timeout: 30000 })
  pending.child.stdin.end()
  await pending
  assert.deepEqual(fake.requests[0].tools.map(tool => tool.function.name).filter(name => name.startsWith('improve_')), [])
})

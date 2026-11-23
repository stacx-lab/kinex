import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { settled, stepLimits } from '../dist/records.js'
import { Refused, admit, describe, next, stop, waveTasks } from '../dist/scheduler.js'
import { claimFile, configFile, resultFile } from '../dist/layout.js'
import { instruction } from '../dist/sim.js'
import { distillTurns, scheduled } from '../dist/distill.js'
import { createLibrary, publish } from '../dist/library.js'

async function directory(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'kinex-self-improve-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}
const put = async (file, text) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text) }

test('a wave runs the open tasks still unsolved and opens the next batch, the distiller\'s order first', () => {
  const tasks = ['a', 'b', 'c', 'd', 'e', 'f']
  const hashed = [...tasks].sort((x, y) => createHash('sha1').update(x).digest('hex').localeCompare(createHash('sha1').update(y).digest('hex')))
  // Without batches every task opens at once, in a fixed order that is not the alphabet's.
  assert.deepEqual(waveTasks(tasks, new Set(), new Set()), hashed)
  assert.notDeepEqual(hashed, tasks)
  // The first batch, then the unsolved of it with the second, then everything left.
  const first = waveTasks(tasks, new Set(), new Set(), [2, 3])
  assert.deepEqual(first, hashed.slice(0, 2))
  const second = waveTasks(tasks, new Set(first), new Set([first[0]]), [2, 3])
  assert.deepEqual(second, [...tasks.filter(task => task === first[1]), ...hashed.slice(2, 5)])
  const opened = new Set([...first, ...second])
  assert.deepEqual(waveTasks(tasks, opened, new Set(first), [2, 3]), [...tasks.filter(task => opened.has(task) && !first.includes(task)), hashed[5]])
  // The distiller's order comes before the fixed one; what it names that is open or unknown is passed over.
  const rest = hashed.slice(2)
  assert.deepEqual(waveTasks(tasks, new Set(first), new Set(first), [2, 2], [rest[3], first[0], 'unknown', rest[1]]), [rest[3], rest[1]])
  // A batch larger than what is left opens what is left.
  assert.deepEqual(waveTasks(tasks, new Set(tasks.slice(0, 5)), new Set(tasks.slice(0, 5)), [5, 20]), ['f'])
})

test('a distillation whose turn did not end normally is tried again twice, then the run goes on', () => {
  const ids = views => settled(views).map(view => view.id)
  const view = (id, status, version) => ({ id, status, ...(version ? { version } : {}), base: 'L0', trials: [], fresh: [], timeoutS: 1 })
  assert.deepEqual(ids([view('d001', 'done', 'L1'), view('d002')]), ['d001'], 'one without a result has settled nothing')
  assert.deepEqual(ids([view('d001', 'done')]), ['d001'], 'a library that could not be repaired is a round: the version before stays')
  assert.deepEqual(ids([view('d001', 'timeout')]), [])
  assert.deepEqual(ids([view('d001', 'timeout'), view('d002', 'error')]), [])
  assert.deepEqual(ids([view('d001', 'timeout'), view('d002', 'error'), view('d003', 'timeout')]), ['d003'], 'the third failure in a row settles it')
  assert.deepEqual(ids([view('d001', 'timeout'), view('d002', 'done', 'L1'), view('d003', 'error')]), ['d002'], 'a turn that ended starts the count again')
})

test('the step limit of a task is known from a trial the simulator ended at it', () => {
  const trial = (task, reason, steps, worldS) => ({ id: 't', task, robot: 'r', library: 'L0', timeoutS: 1, status: 'done', reason, steps, ...(worldS === undefined ? {} : { worldS }) })
  const limits = stepLimits({ versions: [], distillations: [], fresh: [], trials: [
    trial('door', 'timeout', 450, 22.5), trial('door', 'success', 300, 15), trial('lid', 'stopped', 200, 10), trial('oven', 'timeout', 300), trial('oven', 'timeout', 310, 15.5)] })
  assert.deepEqual([...limits], [['door', { steps: 450, worldS: 22.5 }], ['oven', { steps: 310, worldS: 15.5 }]])
})

test('an instruction is read from where the simulator left it, and says where it came from', async t => {
  const root = await directory(t)
  const log = path.join(root, 'graph.log')
  // rosbridge 3702e6e, RoboCasa: fields between the tag and the colon are the simulator's own.
  await put(log, '[INFO] [launch]: All log files can be found below\n[sim_node-1] [robocasa] OpenCabinet seed 101, split target, layout 4, style 4: Open the cabinet doors.\n[sim_node-1] later: noise\n')
  assert.deepEqual(await instruction(log, 'robocasa/open-cabinet'), { text: 'Open the cabinet doors.', source: 'log' })
  await put(log, '[robocasa] OpenCabinet seed 101: Open the cabinet doors.\n')
  assert.deepEqual(await instruction(log, 'robocasa/open-cabinet'), { text: 'Open the cabinet doors.', source: 'log' })
  await put(log, '[sim_node-1] [bidex] place_milk seed 3 (eval seed 5, episode 0): Pick up the milk: put it into the tray.\n')
  assert.deepEqual(await instruction(log, 'bidex/place-milk'), { text: 'Pick up the milk: put it into the tray.', source: 'log' })
  // A simulator that says nothing, or whose line is another's: the task's name, and that it is one.
  assert.deepEqual(await instruction(log, 'libero/pick_up-the-bowl'), { text: 'pick up the bowl', source: 'task name' })
  assert.deepEqual(await instruction(undefined, 'libero/pick_up-the-bowl'), { text: 'pick up the bowl', source: 'task name' })
  // A prompt file in the run's folder comes before the log.
  await put(path.join(root, 'handson/PROMPT.json'), JSON.stringify({ prompt: ' Place the ball in the bowl. ', canonical_prompt: 'hidden' }))
  await put(log, '[handson] t24 seed 1: something else\n')
  assert.deepEqual(await instruction(log, 'handson/t24-place-ball-in-bowl'), { text: 'Place the ball in the bowl.', source: 'file' })
  await put(path.join(root, 'handson/PROMPT.json'), 'not json')
  assert.deepEqual(await instruction(log, 'handson/t24-place-ball-in-bowl'), { text: 'something else', source: 'log' })
})

test('a candidate that fails the check gets repair turns that are shown what it found', async t => {
  const root = await directory(t)
  const workspace = path.join(root, 'workspace')
  const brief = path.join(workspace, 'library/payload/brief.md')
  const distillation = { job: { id: 'd001', directory: root, workspace, record: path.join(root, 'record') }, input: {}, prompt: 'DISTILL', deadline: Date.now() + 60000 }
  const prompts = []
  // The first turn leaves a brief that is too long, the first repair still does, the second mends it.
  const turn = async prompt => { prompts.push(prompt); await put(brief, prompts.length < 3 ? 'x'.repeat(2001) : 'Short.\n'); return { status: 'done' } }
  assert.deepEqual(await distillTurns(distillation, turn), { status: 'done', repairs: 2 })
  assert.equal(prompts[0], 'DISTILL')
  assert.match(prompts[1], /^The library you left did not pass improve_check[^]*\n\npayload\/brief\.md: 1 lines and 2001 characters, at most 15 lines and 2000 characters\n\nThis turn is short: it ends at 20\d\d-[^]*Do not redo the analysis\.$/)
  assert.ok(distillation.deadline > Date.now() + 1700 * 1000, 'a repair turn has half an hour')

  await t.test('two repairs are the most, and a turn that did not end is not repaired', async () => {
    const stubborn = []
    assert.deepEqual(await distillTurns({ ...distillation }, async prompt => { stubborn.push(prompt); await put(brief, 'x'.repeat(2001)); return { status: 'done' } }), { status: 'done', repairs: 2 })
    assert.equal(stubborn.length, 3)
    assert.deepEqual(await distillTurns({ ...distillation }, async () => ({ status: 'timeout' })), { status: 'timeout', repairs: 0 })
    await put(brief, 'Short.\n')
    assert.deepEqual(await distillTurns({ ...distillation }, async () => ({ status: 'done' })), { status: 'done', repairs: 0 })
  })
})

test('the order of new tasks is read from the distillation that made the newest version', async t => {
  const root = await directory(t)
  await createLibrary(root)
  assert.deepEqual(await scheduled(root), [], 'the empty library came from no distillation')
  const candidate = path.join(root, 'candidate')
  await put(path.join(candidate, 'payload/brief.md'), 'Short.\n')
  await publish(root, candidate, { parent: 'L0', source: 'd001' })
  assert.deepEqual(await scheduled(root), [], 'no file orders nothing')
  const file = path.join(root, 'distillations/d001/workspace/schedule.json')
  await put(file, JSON.stringify({ next: ['sim/b', 7, 'sim/a'], why: 'b adds one capability' }))
  assert.deepEqual(await scheduled(root), ['sim/b', 'sim/a'])
  for (const text of ['[]', 'not json', '{"next": "sim/a"}']) {
    await put(file, text)
    assert.deepEqual(await scheduled(root), [])
  }
})

// A run's folder as improve_plan leaves it. A job is opened by the process that does it, here this one, so it
// counts as running until it is finished: a result, and a claim whose process is gone.
async function scheduledRun(t, config) {
  const root = await directory(t)
  const full = { selection: 'the tasks', robot: 'arm', rounds: 2, parallel: 2, trialTimeoutS: 60, distillTimeoutS: 60, rosbridge: 'rosbridge', ...config }
  await put(configFile(root), JSON.stringify(full))
  await createLibrary(root)
  return { root, config: full }
}
const finish = async (job, result) => {
  await put(claimFile(job.directory), JSON.stringify({ pid: 2 ** 22 + 1 }))
  await put(resultFile(job.directory), JSON.stringify(result))
}
const judged = success => ({ status: 'done', success, steps: 40 })

test('the next step is read from the run\'s folder and a job is opened when its sub-agent asks: a wave some trials at a time, then its distillation, then the next wave', async t => {
  const run = await scheduledRun(t, { tasks: ['a', 'b', 'c'] })
  const first = await next(run)
  // Tasks open in a fixed order that is not the alphabet's.
  const [x, y, z] = first.tasks
  assert.deepEqual([first.kind, first.wave, first.library, [x, y, z].sort(), first.running], ['trials', 1, 'L0', ['a', 'b', 'c'], []])
  assert.deepEqual(await next(run), first, 'asking opens nothing')
  // The wave starts as one call, which the session makes: its tasks, the library their workers get, and how many run at a time.
  assert.ok((await describe(run, first)).startsWith(`Wave 1: 3 tasks to try, 2 at a time, each a trial in a background sub-agent. Start them with this call, unless you did a moment ago:
subagent({ workflow: ${JSON.stringify(path.join(run.root, 'wave.js'))}, args: { run: "${path.basename(run.root)}", library: "L0", tasks: ${JSON.stringify(first.tasks)} }, globalConcurrencyLimit: 2, async: true })
library is the version the workers are given: L0 is the newest. Nothing else in the call is yours to change.`))

  // Each trial asks to be admitted. As many run as the plan allows, whatever was started: a third waits for one to end.
  const one = await admit(run, { task: x })
  const two = await admit(run, { task: y })
  assert.deepEqual([one.id, two.id], ['t001', 't002'])
  await assert.rejects(admit(run, { task: z }, AbortSignal.timeout(100)), { name: 'TimeoutError' })
  // What the scheduler does not have to do is refused: a task that is being tried, one of no wave, a version that does not exist, a distillation before its wave is done.
  await assert.rejects(admit(run, { task: x }), { message: `${x} is not to be tried now: wave 1 has ${z} to try` })
  await assert.rejects(admit(run, { task: 'other' }), Refused)
  await assert.rejects(admit(run, { task: z, library: 'L7' }), /No library version L7; the run has L0/)
  await assert.rejects(admit(run, 'distill'), /No distillation is to be started: wave 1 has/)
  await finish(two, judged(false))
  const three = await admit(run, { task: z })
  assert.equal(three.id, 't003')
  assert.deepEqual(await next(run), { kind: 'wait', running: ['t001', 't003'] })
  assert.match(await describe(run, await next(run)), /^Nothing to start: t001, t003 are still running\./)
  await finish(one, judged(true))
  await finish(three, judged(false))

  // The wave is distilled before another opens, and no trial is admitted meanwhile.
  assert.deepEqual(await next(run), { kind: 'distill' })
  assert.match(await describe(run, { kind: 'distill' }), new RegExp(`\nsubagent\\(\\{ agent: "self-improve-distill", task: "run=${path.basename(run.root)}" \\}\\)\n`))
  await assert.rejects(admit(run, { task: y }), /is not to be tried now: the wave is to be distilled/)
  const distill = await admit(run, 'distill')
  assert.equal(distill.id, 'd001')
  assert.deepEqual(await next(run), { kind: 'wait', running: ['d001'] })
  await assert.rejects(admit(run, 'distill'), /No distillation is to be started: d001 is still running/)
  // A distillation whose session did not end normally settled nothing: the same trials are distilled again.
  await finish(distill, { status: 'timeout' })
  const retried = await admit(run, 'distill')
  assert.equal(retried.id, 'd002')
  await finish(retried, { status: 'done', version: 'L1' })
  await publish(run.root, path.join(run.root, 'libraries/L0'), { parent: 'L0', source: 'd002' })

  // The next wave gives every task still unsolved a trial with the newest version, unless the session gives another.
  const second = await next(run)
  assert.deepEqual([second.wave, second.library, [...second.tasks].sort()], [2, 'L1', [y, z].sort()])
  assert.match(await describe(run, second), /library is the version the workers are given: L1 is the newest, and it may be another of L0, L1\./)
  const jobs = [await admit(run, { task: y, library: 'L0' }), await admit(run, { task: z })]
  const inputs = await Promise.all(jobs.map(async job => JSON.parse(await readFile(path.join(job.directory, 'input.json'), 'utf8'))))
  assert.deepEqual(inputs.map(input => [input.wave, input.task, input.library]), [[2, y, 'L0'], [2, z, 'L1']])
  for (const job of jobs) await finish(job, judged(true))
  const end = await next(run)
  assert.deepEqual(end, { kind: 'end', reason: 'every task is solved' })
  assert.match(await describe(run, end), /has ended: every task is solved\.\n\nRun: [^]*Tasks: 3\/3 solved[^]*\/self-improve install <version>/)
})

test('a trial that did not run is tried again twice, and a wave none of whose trials ran ends the run', async t => {
  const run = await scheduledRun(t, { tasks: ['a'], parallel: 1 })
  for (const id of ['t001', 't002', 't003']) {
    assert.deepEqual((await next(run)).tasks, ['a'])
    const job = await admit(run, { task: 'a' })
    assert.equal(job.id, id)
    // An error is a result, and a process that ended without one abandoned its trial: neither says anything of the task.
    if (id === 't002') await put(claimFile(job.directory), JSON.stringify({ pid: 2 ** 22 + 1 }))
    else await finish(job, { status: 'error', error: 'rosbridge launch: no simulator could start' })
  }
  const end = await next(run)
  assert.deepEqual([end.kind, end.failed], ['end', true])
  assert.match(end.reason, /^no trial of the wave ran: t001 \(a\): rosbridge launch: no simulator could start; t003 \(a\)/)
  assert.match(await describe(run, end), /stopped on an error: no trial of the wave ran[^]*\/self-improve resume continues it\./)
  await assert.rejects(admit(run, { task: 'a' }), /a is not to be tried now: the run has ended: no trial of the wave ran/)
})

test('a run ends when its rounds are done, and stopping tells the processes of its jobs', async t => {
  const run = await scheduledRun(t, { tasks: ['a'], rounds: 1, parallel: 1 })
  await finish(await admit(run, { task: 'a' }), judged(false))
  await finish(await admit(run, 'distill'), { status: 'done', problems: ['payload/brief.md: too long'] })
  assert.deepEqual(await next(run), { kind: 'end', reason: 'its rounds are done' }, 'a library that could not be published is still a round')
  // Only a job whose process is alive is stopped; here none is.
  assert.deepEqual(await stop(run), [])
})

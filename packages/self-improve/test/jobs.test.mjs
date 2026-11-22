import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createJobs, line } from '../dist/jobs/index.js'
import { startTool, tools } from '../dist/jobs/tools.js'

const gate = () => Promise.withResolvers()
const tick = () => new Promise(resolve => setImmediate(resolve))

test('starting returns at once and a wait collects the cards', async () => {
  const jobs = createJobs()
  const open = gate()
  const started = jobs.start({ id: 't001', record: 'trials/t001/record', run: () => open.promise })
  assert.deepEqual(started, { id: 't001', lane: 'default', state: 'running', record: 'trials/t001/record' })
  assert.deepEqual((await jobs.wait(['t001'], { timeoutS: 0.01 })).map(card => card.state), ['running'], 'a wait that times out leaves the job running')
  open.resolve({ summary: 'success, 41 steps' })
  const [card] = await jobs.wait()
  assert.deepEqual(card, { id: 't001', lane: 'default', state: 'ended', status: 'done', summary: 'success, 41 steps', record: 'trials/t001/record' })
  assert.equal(line(card), 't001 done · success, 41 steps · record: trials/t001/record')
  assert.deepEqual(await jobs.wait(), [], 'nothing is left to wait for')
  assert.throws(() => jobs.start({ id: 't001', run: async () => {} }), /already started/)
  await assert.rejects(jobs.wait(['t999']), /No job t999/)
})

test('a lane runs up to its limit and queues the rest, whatever the work is', async () => {
  const ended = []
  const jobs = createJobs({ limits: { trials: 2 }, onEnd: card => ended.push(card.id) })
  const gates = [gate(), gate(), gate()]
  const order = []
  for (const [index, open] of gates.entries()) jobs.start({ id: `t${index}`, lane: 'trials', run: async () => { order.push(index); return open.promise } })
  jobs.start({ id: 'other', lane: 'helpers', run: async () => {} })
  await tick()
  assert.deepEqual(order, [0, 1])
  assert.deepEqual(jobs.list().map(card => card.state), ['running', 'running', 'queued', 'ended'], 'another lane does not wait behind this one')
  gates[0].resolve()
  await tick()
  assert.deepEqual(order, [0, 1, 2], 'the queued job starts when a slot frees')
  gates[1].reject(new Error('the simulator did not start'))
  gates[2].resolve({ status: 'timeout' })
  assert.deepEqual((await jobs.wait()).map(line), ['t1 error · the simulator did not start', 't2 timeout'])
  assert.deepEqual(ended, ['other', 't0', 't1', 't2'], 'every end is reported once')
})

test('waiting for any returns with the first end, and a cancelled wait ends no job', async () => {
  const jobs = createJobs()
  const slow = gate(), fast = gate()
  jobs.start({ id: 'slow', run: () => slow.promise })
  jobs.start({ id: 'fast', run: () => fast.promise })
  const any = jobs.wait(undefined, { mode: 'any' })
  fast.resolve()
  assert.deepEqual((await any).map(card => card.state), ['running', 'ended'])
  assert.deepEqual((await jobs.wait(['slow', 'fast'], { mode: 'any' })).map(card => card.state), ['running', 'ended'], 'one that ended earlier counts')
  const cancel = new AbortController()
  const waiting = jobs.wait(['slow'], { signal: cancel.signal })
  cancel.abort(new Error('the turn was cancelled'))
  await assert.rejects(waiting, /the turn was cancelled/)
  assert.equal(jobs.get('slow').state, 'running')
  slow.resolve()
  await jobs.wait()
})

test('stopping aborts running work and ends queued work at once', async () => {
  const jobs = createJobs({ limits: { default: 1 } })
  const ran = []
  const work = id => signal => { ran.push(id); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))) }
  jobs.start({ id: 'a', run: work('a') })
  jobs.start({ id: 'b', run: work('b') })
  jobs.start({ id: 'c', run: work('c') })
  await tick()
  jobs.stop('b')
  assert.equal(jobs.get('b').status, 'stopped')
  jobs.stop()
  assert.deepEqual((await jobs.wait(['a', 'b', 'c'])).map(card => card.status), ['stopped', 'stopped', 'stopped'])
  assert.deepEqual(ran, ['a'], 'work that was still queued never ran')
})

test('the tools are the same operations for a model', async () => {
  const jobs = createJobs({ limits: { helpers: 1 } })
  const open = gate()
  const delegate = startTool(jobs, {
    name: 'delegate', description: 'Start a sub-agent.', lane: 'helpers',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    job: args => ({ id: args.name, record: `helpers/${args.name}`, run: () => open.promise }),
  })
  const { wait, status, stop } = tools(jobs, { prefix: 'job' })
  assert.deepEqual([wait.name, status.name, stop.name], ['job_wait', 'job_status', 'job_stop'])
  const signal = new AbortController().signal
  assert.deepEqual(await delegate.execute({ name: 'door' }, signal), { title: 'door started', text: 'Started door.' })
  assert.match((await delegate.execute({ name: 'grasp' }, signal)).text, /queued behind the others/)
  assert.equal((await wait.execute({ timeout_s: 0.01 }, signal)).title, '0/2 ended')
  await stop.execute({ id: 'grasp' }, signal)
  open.resolve({ summary: 'notes/door.md written' })
  assert.deepEqual(await wait.execute({ ids: ['door', 'grasp'] }, signal), { title: '2/2 ended', text: 'door done · notes/door.md written · record: helpers/door\ngrasp stopped · record: helpers/grasp' })
  assert.match((await status.execute({}, signal)).text, /^door done/)
  assert.deepEqual(await wait.execute({}, signal), { title: '0/0 ended', text: 'Nothing is running.' })
})

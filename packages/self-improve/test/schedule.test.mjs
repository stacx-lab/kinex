import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { stepLimits } from '../dist/records.js'
import { instruction } from '../dist/sim.js'

async function directory(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'kinex-self-improve-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}
const put = async (file, text) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text) }

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

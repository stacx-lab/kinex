import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isolate, workspace } from './helpers.mjs'

const isolation = await isolate()
after(isolation.cleanup)
const { createKinexRuntime } = await import('@kinex/core')
const { selfImproveContribution } = await import('@kinex/self-improve')
const { checked, named, current } = await import('@kinex/self-improve/scheduler')

const catalog = [{ id: 'sim/open-door', robot: 'sim/arm' }, { id: 'sim/press-button', robot: 'sim/arm' }, { id: 'lab/stack', robot: 'lab/hand' }]
const command = { sessionID: 'session', confirm: async () => false }

test('ids and patterns name a run\'s tasks without a model; anything else is free text', () => {
  assert.deepEqual(named('sim/press-button sim/open-door', catalog), ['sim/press-button', 'sim/open-door'])
  assert.deepEqual(named('sim/*', catalog), ['sim/open-door', 'sim/press-button'])
  assert.deepEqual(named('sim/* sim/open-door', catalog), ['sim/open-door', 'sim/press-button'], 'a task named twice is one task')
  assert.equal(named('two sim tasks about doors', catalog), undefined)
  assert.equal(named('sim/open-door and one more', catalog), undefined, 'one part that is neither makes the whole request free text')
  assert.deepEqual(checked(['sim/press-button', 'sim/open-door', 'sim/open-door'], catalog), ['sim/open-door', 'sim/press-button'])
  assert.throws(() => checked(['sim/open-door', 'sim/missing'], catalog), /Unknown tasks: sim\/missing/)
  assert.throws(() => checked(['sim/open-door', 'lab/stack'], catalog), /different robots \(sim\/arm, lab\/hand\)/)
  assert.throws(() => checked([], catalog), /at least one task/)
})

test('a session that was given no turn has none of the tools, and a run needs a host that can give one', async t => {
  const directory = await workspace(t)
  const runtime = createKinexRuntime({ directory })
  t.after(() => runtime.dispose())
  const session = selfImproveContribution(runtime)
  assert.deepEqual((await session.tools.list()).tools, [])
  assert.throws(() => session.tools.call('improve_check', {}, { sessionID: 'session', callID: 'call', abort: new AbortController().signal }), /unknown self-improve tool/)
  const [improve] = session.commands
  await assert.rejects(improve.execute('sim/open-door', command), /cannot give the session a turn/)
  await assert.rejects(improve.execute('sim/open-door', { ...command, turn: async () => {}, unattended: async () => false }), /switch with \/mode auto, or start Kinex with --auto/)
  await assert.rejects(improve.execute('', command), /Usage: \/self-improve/)
  await assert.rejects(improve.execute('stop now', command), /Usage: \/self-improve/)
  assert.deepEqual(await improve.execute('stop', command), { kind: 'output', text: 'No self-improve run is scheduled in this Kinex.' })
  assert.equal(current(), undefined, 'a refused run schedules nothing')
})

test('an installed brief is a context section of each session, never an instruction', async t => {
  const directory = await workspace(t)
  const runtime = createKinexRuntime({ directory })
  t.after(() => runtime.dispose())
  const file = path.join(directory, '.kinex/self-improve/brief.md')
  const session = selfImproveContribution(runtime)
  assert.deepEqual(await session.context(), { instructions: '', sections: {} })
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, 'Load the press skill first.\n')
  assert.deepEqual(await session.context(), { instructions: '', sections: { brief: 'Load the press skill first.' } })
  // A session that was given a brief is told when it is gone; one that never was hears nothing.
  await rm(file)
  assert.deepEqual(await session.context(), { instructions: '', sections: { brief: '' } })
  assert.deepEqual(await selfImproveContribution(runtime).context(), { instructions: '', sections: {} })
})

test('loading self-improve registers no process listener', async () => {
  const entry = fileURLToPath(import.meta.resolve('@kinex/self-improve'))
  const script = `const before = process.listenerCount('exit'); await import(${JSON.stringify(entry)}); console.log(process.listenerCount('exit') - before)`
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script])
  assert.equal(stdout.trim(), '0')
})

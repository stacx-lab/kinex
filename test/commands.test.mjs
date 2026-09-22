import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { isolate, workspace, seed } from './helpers.mjs'
const isolation = await isolate()
after(isolation.cleanup)
const { createKinexRuntime, executeRoboticsCommand } = await import('@kinex/core')

test('shared commands validate arguments, preserve approval boundaries and distinguish workflows', async t => {
  const cwd = await workspace(t)
  const core = createKinexRuntime({ directory: cwd })
  t.after(() => core.dispose())
  await seed(core)
  const context = { sessionID: 'command', confirm: async () => false }
  await assert.rejects(executeRoboticsCommand(core, 'load', '', context), /Usage/)
  assert.equal((await executeRoboticsCommand(core, 'register', 'rgb camera', context)).kind, 'workflow')
  assert.equal((await core.devices.list())[0].loaded, false)
  await executeRoboticsCommand(core, 'load', 'all', context)
  assert.equal((await core.devices.list())[0].loaded, true)
  assert.match((await executeRoboticsCommand(core, 'unregister', 'sensor', context)).text, /Cancelled/)
  assert.equal((await core.devices.list()).length, 1)
  await assert.rejects(core.tools.call('device', { deviceID: 'sensor', action: 'unload' }, { sessionID: 'model' }), /Permission/)
  await executeRoboticsCommand(core, 'unregister', 'sensor', { ...context, confirm: async () => true })
  assert.equal((await core.devices.list()).length, 0)
})

test('manual recording omits empty optional fields by default and accepts --verbose after the action', async t => {
  const core = createKinexRuntime({ directory: await workspace(t) })
  t.after(() => core.dispose())
  await seed(core)
  const context = { sessionID: 'command', confirm: async () => false }
  await executeRoboticsCommand(core, 'load', 'sensor', context)
  const run = async args => JSON.parse((await executeRoboticsCommand(core, 'record', args, context)).text)
  const snap = await run('snap sensor')
  assert.equal('refusals' in snap, false)
  assert.deepEqual(snap.readings.sensor.data.faults, [])
  assert.deepEqual((await run('snap --verbose sensor')).refusals, {})
  const start = await run('start sensor=2')
  assert.equal('refusals' in start, false)
  assert.equal('passive' in start.manifest, false)
  assert.equal('passive' in (await run('status')).active, false)
  assert.deepEqual((await run('status --verbose')).active.passive, {})
  const stopped = await run('stop success')
  assert.equal(stopped.outcome, 'success')
  assert.equal('messageRange' in stopped, false)
  assert.deepEqual((await core.recording.recent())[0].messageRange, {})
  await assert.rejects(run('status unexpected'), /Usage/)
})

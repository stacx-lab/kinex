import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createKinexRuntime, executeRoboticsCommand } from '../dist/index.js'
import { protocolDevice, protocolFramePython } from './fixtures/protocol.mjs'

const config = await mkdtemp(path.join(tmpdir(), 'kinex-commands-config-'))
process.env.KINEX_CONFIG_DIR = config
after(() => rm(config, { recursive: true, force: true }))

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'kinex-commands-'))
  const core = createKinexRuntime({ directory })
  t.after(async () => { await core.dispose(); await rm(directory, { recursive: true, force: true }) })
  await protocolFramePython(core)
  await core.profiles.writeManifest({ identity: { id: 'test', name: 'Test', kind: 'arm' } })
  await protocolDevice(core, directory)
  return core
}

test('shared commands validate arguments, preserve approval boundaries and distinguish workflows', async t => {
  const core = await fixture(t)
  const context = { sessionID: 'command', confirm: async () => false }
  await assert.rejects(executeRoboticsCommand(core, 'load', '', context), /Usage/)
  await assert.rejects(executeRoboticsCommand(core, 'reload', 'sensor', context), /Unknown robotics command: reload/)
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
  const core = await fixture(t)
  const context = { sessionID: 'command', confirm: async () => false }
  await executeRoboticsCommand(core, 'load', 'sensor', context)
  const run = async args => JSON.parse((await executeRoboticsCommand(core, 'record', args, context)).text)
  const snap = await run('snap sensor')
  assert.equal('refusals' in snap, false)
  assert.deepEqual(snap.readings.sensor.data.faults, [])
  assert.deepEqual((await run('snap --verbose sensor')).refusals, {})
  await assert.rejects(run('status unexpected'), /Usage/)
})

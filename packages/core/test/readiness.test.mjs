import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createKinexRuntime } from '../dist/index.js'

test('core alone validates calibration clears and reports readiness without procedural guidance', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kinex-readiness-'))
  const runtime = createKinexRuntime({ directory })
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  await runtime.profiles.writeManifest({ identity: { id: 'existing', name: 'Existing', kind: 'arm', platform: 'real' } })
  await runtime.profiles.writeDevice({ name: 'sensor', type: 'other', loaded: false,
    access: { connection: '???', needs_calibration: 'verify connection' } })
  const file = path.join(directory, '.kinex/devices/sensor/profile.yaml')
  const before = await readFile(file, 'utf8')
  const readiness = await runtime.readiness()
  assert.equal(readiness.items.find(item => item.id === 'access:sensor').status, 'needs-calibration')
  assert.ok(readiness.items.every(item => !('how' in item)))
  await assert.rejects(runtime.profiles.writeDevice({ name: 'sensor', access: { needs_calibration: null } }), /cannot clear/)
  assert.equal(await readFile(file, 'utf8'), before)
  await runtime.profiles.writeDevice({ name: 'sensor', access: { connection: { kind: 'mock' }, needs_calibration: null } })
  assert.equal((await runtime.readiness()).items.find(item => item.id === 'access:sensor').status, 'done')
  const context = await runtime.context()
  assert.doesNotMatch(context.instructions + context.robotics + context.guideRoots, /calib_plan|calib_write|\/onboarding|\/register|\/calibrate|setup-device/)
})

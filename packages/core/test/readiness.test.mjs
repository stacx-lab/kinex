import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
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
  assert.match(context.readiness, /access:sensor: done/)
  assert.doesNotMatch(context.instructions + context.robotics + context.guideRoots, /calib_plan|calib_write|\/onboarding|\/calibrate/)
})

test('readiness reports a missing driver interpreter before the action check', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kinex-readiness-'))
  const runtime = createKinexRuntime({ directory })
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  await runtime.profiles.writeManifest({ identity: { id: 'existing', name: 'Existing', kind: 'arm', platform: 'real' } })
  const driver = { actions: ['load', 'unload', 'status', 'read'] }
  await runtime.profiles.writeDevice({ name: 'sensor', type: 'other', loaded: false,
    access: { connection: { kind: 'process' }, driver: { ...driver, interpreter: '/nonexistent/device-python' } } })
  await mkdir(path.join(directory, '.kinex/devices/sensor'), { recursive: true })
  await writeFile(path.join(directory, '.kinex/devices/sensor/driver.py'), 'raise SystemExit(1)\n')
  const access = async () => (await runtime.readiness()).items.find(item => item.id === 'access:sensor')
  const missing = await access()
  assert.notEqual(missing.status, 'done')
  assert.match(missing.detail, /does not exist/)
  await runtime.profiles.writeDevice({ name: 'sensor', access: { driver: { ...driver, interpreter: process.env.PYTHON ?? 'python3' } } })
  assert.equal((await access()).status, 'done')
})


test('readiness and calibration clearing resolve interpreters beside the driver entry', { skip: process.platform === 'win32' }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kinex-readiness-'))
  const runtime = createKinexRuntime({ directory })
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  await runtime.profiles.writeManifest({ identity: { id: 'test', name: 'Test', kind: 'arm', platform: 'real' } })
  await runtime.profiles.writeDevice({ name: 'sensor', type: 'other', loaded: false,
    access: { connection: { kind: 'process' }, driver: {
      entry: 'runtime/driver.mjs', interpreter: '../bin/node', persistent: true,
      actions: ['load', 'unload', 'status', 'read'],
    } } })
  const device = path.join(directory, '.kinex/devices/sensor')
  await mkdir(path.join(device, 'runtime'))
  await mkdir(path.join(device, 'bin'))
  await writeFile(path.join(device, 'runtime/driver.mjs'), `import { createInterface } from 'node:readline'
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line)
  console.log(JSON.stringify({ id: request.id, ok: true, value: 7 }))
}
`)
  const access = async () => (await runtime.readiness()).items.find(item => item.id === 'access:sensor')
  assert.match((await access()).detail, /interpreter.*does not exist/)
  await symlink(process.execPath, path.join(device, 'bin/node'))
  assert.equal((await access()).status, 'done')
  await runtime.profiles.writeDevice({ name: 'sensor', access: { needs_calibration: 'verify access' } })
  await runtime.profiles.writeDevice({ name: 'sensor', access: { needs_calibration: null } })
  await (await runtime.devices.load('sensor')).ready
  assert.equal((await runtime.devices.dispatch('sensor', 'read')).data.value, 7)
  await runtime.devices.unload('sensor')
  await assert.rejects(stat(path.join(directory, '.kinex/python')), { code: 'ENOENT' })
})

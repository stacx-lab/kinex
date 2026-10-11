import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse, stringify } from 'yaml'
import { provisionBundle, runPython, library, coreLibrary, fakeRos } from './bundle-harness.mjs'

for (const kind of ['joint', 'velocity', 'imu', 'rgb', 'rgbd']) {
  test(`bundle harness provisions and registers the ${kind} ROS adapter contract`, async t => {
    const source = await mkdtemp(path.join(os.tmpdir(), 'kinex-bundle-source-'))
    t.after(() => rm(source, { recursive: true, force: true }))
    const tests = fileURLToPath(new URL('.', import.meta.url))
    runPython(['-c', 'import sys; from ros2_fixtures import fixture; fixture(sys.argv[1], sys.argv[2])', source, kind], {
      env: { PYTHONPATH: [library, coreLibrary, tests].join(path.delimiter) },
    })
    const bundle = await provisionBundle(t, source)
    assert.equal(bundle.profile.type, kind)
    const procedure = kind === 'velocity' ? 'verify-base-interface' : kind === 'joint' ? 'verify-joint-interface' : 'verify-sensor-interface'
    const descriptor = JSON.parse(await readFile(new URL(`../assets/builtin/skill/${procedure}/procedure.json`, import.meta.url), 'utf8'))
    const command = bundle.provision().next.find(command => command.startsWith('calib_compute '))
    assert.ok(descriptor.computes.includes(command.match(/operation:(\S+)/)[1]), command)
    await assert.rejects(stat(path.join(bundle.directory, 'DEVICE.md')), { code: 'ENOENT' })
    await bundle.runtime.profiles.writeDevice({ name: bundle.profile.name, loaded: true })
    assert.match((await bundle.runtime.context()).conventions, new RegExp(`type="${kind}"`))
    if (kind === 'rgb' || kind === 'rgbd') {
      const patch = JSON.parse(runPython(['-c', [
        'import json,sys',
        'from kinex_ros.ros2_drivers import CameraSource',
        'camera = CameraSource(sys.argv[1])',
        'try: print(json.dumps(camera.introspect()))',
        'finally: camera.close()',
      ].join('\n'), bundle.generation], { env: {
        PYTHONPATH: [library, coreLibrary, fakeRos].join(path.delimiter), ROS_DOMAIN_ID: '0',
        KINEX_FAKE_RCLPY_SCENARIO: path.join(source, 'scenario.json'),
      } }))
      await bundle.runtime.profiles.writeDevice({ name: bundle.profile.name, ...patch })
      assert.equal(patch.intrinsics.color.width, 2)
      if (kind === 'rgbd') assert.equal(patch.intrinsics.depth.width, 2)
    }
  })
}

test('bundle profile accepts a typed numeric fact without a custom provisioner', async t => {
  const source = await mkdtemp(path.join(os.tmpdir(), 'kinex-bundle-source-'))
  t.after(() => rm(source, { recursive: true, force: true }))
  const tests = fileURLToPath(new URL('.', import.meta.url))
  runPython(['-c', 'import sys; from ros2_fixtures import fixture; fixture(sys.argv[1], "rgb")', source], {
    env: { PYTHONPATH: [library, coreLibrary, tests].join(path.delimiter) },
  })
  const file = path.join(source, 'bundle.yaml')
  const manifest = parse(await readFile(file, 'utf8'))
  manifest.facts.push({ key: 'width', type: 'int', default: 640 })
  manifest.profile.intrinsics.color.width = '${width}'
  await writeFile(file, stringify(manifest))
  const bundle = await provisionBundle(t, source, { facts: { width: 640 } })
  assert.equal(bundle.profile.intrinsics.color.width, 640)
})


test('legacy profile migration replaces access while preserving calibration and user settings', async t => {
  const source = await mkdtemp(path.join(os.tmpdir(), 'kinex-legacy-source-'))
  t.after(() => rm(source, { recursive: true, force: true }))
  const tests = fileURLToPath(new URL('.', import.meta.url))
  runPython(['-c', 'import sys; from ros2_fixtures import fixture; fixture(sys.argv[1], "rgb")', source], {
    env: { PYTHONPATH: [library, coreLibrary, tests].join(path.delimiter) },
  })
  const bundle = await provisionBundle(t, source, { facts: { domain_id: 7, namespace: '/camera' } })
  const file = path.join(bundle.directory, 'profile.yaml')
  const original = parse(await readFile(file, 'utf8'))
  const legacy = structuredClone(original)
  Object.assign(legacy.access.connection, {domain_id: 7, namespace: '/camera', camera_info_topic: '/info'})
  legacy.access.driver.entry = 'driver.py'
  legacy.access.driver.interpreter = path.join(bundle.directory, 'ros-python')
  await writeFile(file, stringify(legacy))
  const migration = await bundle.runtime.tools.call('profile_write', { kind: 'device', replace: ['access'], data: {
    name: original.name, access: original.access,
  } }, { sessionID: 'migrate', ask: async () => {} })
  assert.ok(!migration.isError, migration.output)
  const repaired = parse(await readFile(file, 'utf8'))
  assert.deepEqual(repaired.intrinsics, original.intrinsics)
  assert.deepEqual(repaired.extrinsics, original.extrinsics)
  assert.deepEqual(repaired.access, original.access)
  assert.equal(repaired.loaded, false)
  const facts = parse(await readFile(path.join(bundle.generation, 'facts.yaml'), 'utf8'))
  assert.equal(facts.domain_id, 7)
  assert.equal(facts.namespace, '/camera')
  const before = await readFile(file, 'utf8')
  const rejected = await bundle.runtime.tools.call('profile_write', { kind: 'device', replace: ['access'], data: {
    name: original.name, access: legacy.access,
  } }, { sessionID: 'migrate', ask: async () => {} })
  assert.equal(rejected.isError, true)
  assert.equal(await readFile(file, 'utf8'), before)
})

test('failed reprovisioning and candidate load preserve a working selected generation', async t => {
  const { spawnSync } = await import('node:child_process')
  const source = await mkdtemp(path.join(os.tmpdir(), 'kinex-reprovision-source-'))
  t.after(() => rm(source, { recursive: true, force: true }))
  const tests = fileURLToPath(new URL('.', import.meta.url))
  runPython(['-c', 'import sys; from ros2_fixtures import fixture; fixture(sys.argv[1])', source], {
    env: { PYTHONPATH: [library, coreLibrary, tests].join(path.delimiter) },
  })
  const bundle = await provisionBundle(t, source)
  const profileFile = path.join(bundle.directory, 'profile.yaml')
  const selected = await readFile(profileFile, 'utf8')
  const driver = await readFile(path.join(bundle.generation, 'driver.py'), 'utf8')
  await writeFile(path.join(source, 'driver.py'), 'invalid Python ???')
  const attempt = spawnSync(process.env.PYTHON ?? 'python3', [path.join(source, 'provision.py'), '--dir', bundle.directory,
    '--core-library', coreLibrary, '--setup-library', library], { encoding: 'utf8',
    env: { ...process.env, ...bundle.env, PYTHONPATH: [library, coreLibrary].join(path.delimiter) } })
  assert.equal(attempt.status, 1, attempt.stdout + attempt.stderr)
  assert.equal(await readFile(profileFile, 'utf8'), selected)
  assert.equal(await readFile(path.join(bundle.generation, 'driver.py'), 'utf8'), driver)
  const env = { PYTHONPATH: fakeRos, KINEX_FAKE_RCLPY_SCENARIO: path.join(source, 'scenario.json'), ROS_DOMAIN_ID: '0' }
  for (const [key, value] of Object.entries(env)) {
    const previous = process.env[key]
    process.env[key] = value
    t.after(() => previous === undefined ? delete process.env[key] : process.env[key] = previous)
  }
  const operate = async () => {
    await (await bundle.runtime.devices.load('arm')).ready
    assert.equal((await bundle.runtime.devices.dispatch('arm', 'read')).data.positions.length, 2)
    await bundle.runtime.devices.dispatch('arm', 'stop')
    await bundle.runtime.devices.unload('arm')
  }
  await operate()
  await writeFile(path.join(source, 'driver.py'), 'raise RuntimeError("candidate failed")\n')
  const candidate = bundle.provision().generations.arm
  const profile = JSON.parse(await readFile(path.join(candidate, 'profile.generated.json'), 'utf8'))
  const select = async access => {
    const result = await bundle.runtime.tools.call('profile_write', { kind: 'device', replace: ['access'],
      data: { name: 'arm', access } }, { sessionID: 'recover', ask: async () => {} })
    assert.ok(!result.isError, result.output)
  }
  await select(profile.access)
  await assert.rejects(async () => { await (await bundle.runtime.devices.load('arm')).ready })
  await bundle.runtime.devices.unload('arm')
  await select(bundle.profile.access)
  await operate()
})

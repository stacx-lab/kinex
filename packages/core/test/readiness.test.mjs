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
  await runtime.profiles.writeManifest({ identity: { id: 'existing', name: 'Existing', kind: 'arm' } })
  await runtime.profiles.writeDevice({ description: '',
    name: 'sensor',
    type: 'other',
    loaded: false,
    access: { needs_calibration: 'verify connection' },
    frames: { base: {parent: null, translation_m: null, rotation_xyzw: null} } })
  const file = path.join(directory, '.kinex/devices/sensor/profile.yaml')
  const before = await readFile(file, 'utf8')
  const readiness = await runtime.readiness()
  assert.equal(readiness.items.find(item => item.id === 'access:sensor').status, 'needs-calibration')
  assert.ok(readiness.items.every(item => !('how' in item)))
  assert.match(readiness.items.find(item => item.id === 'devices-declared').detail, /no world device/)
  await assert.rejects(runtime.profiles.writeDevice({ description: '', name: 'sensor', access: { needs_calibration: null } }), /cannot clear/)
  assert.equal(await readFile(file, 'utf8'), before)
  await runtime.profiles.writeDevice({ description: '', name: 'sensor', runtime: {nodes: []}, access: {needs_calibration: null} })
  assert.equal((await runtime.readiness()).items.find(item => item.id === 'access:sensor').status, 'done')
  await runtime.profiles.writeDevice({ description: '', name: 'world', type: 'world', loaded: false,
    frames: { base: {parent: null, translation_m: null, rotation_xyzw: null} } })
  assert.equal((await runtime.readiness()).items.find(item => item.id === 'devices-declared').status, 'done')
  const context = await runtime.context()
  assert.doesNotMatch(context.instructions + context.guideRoots, /calib_plan|calib_write|\/onboarding|\/calibrate/)
})

test('model readiness requires compute placement; detection is a model, not a type', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kinex-model-readiness-'))
  const runtime = createKinexRuntime({ directory })
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  await runtime.profiles.writeManifest({ identity: { id: 'models', name: 'Models', kind: 'other' } })
  const model = { description: '', name: 'detector', type: 'model', loaded: false, runtime: { nodes: [] },
    family: 'grounding_dino', artifacts: [], operations: { detect: { description: '', transport: 'service',
      direction: 'input', endpoint: '/kinex/detector/detect', type: 'std_srvs/srv/Trigger' } } }
  await runtime.profiles.writeDevice(model)
  const detail = async () => (await runtime.readiness()).items.find(item => item.id === 'profile:detector').detail
  assert.equal(await detail(), 'compute is ???')
  await runtime.profiles.writeDevice({ description: '', name: 'detector', compute: { kind: 'cuda', index: 1 } })
  assert.equal(await detail(), 'grounding_dino on cuda:1: detect')
  await assert.rejects(runtime.profiles.writeDevice({ ...model, name: 'legacy', type: 'detection' }))
})

test('suction readiness requires vacuum control, stop scope and a contact TCP', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kinex-suction-readiness-'))
  const runtime = createKinexRuntime({ directory })
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  await runtime.profiles.writeManifest({ identity: { id: 'suction', name: 'Suction', kind: 'arm' } })
  const root = { parent: null, translation_m: null, rotation_xyzw: null }
  await runtime.profiles.writeDevice({ description: '', name: 'cup', type: 'suction', loaded: false, runtime: { nodes: [] },
    stop: { behavior: 'hold', affected_devices: ['cup'] }, frames: { base: root } })
  const detail = async () => (await runtime.readiness()).items.find(item => item.id === 'profile:cup').detail
  assert.equal(await detail(), 'vacuum or stop is incomplete')
  await runtime.profiles.writeDevice({ description: '', name: 'cup', vacuum: 'proportional' })
  assert.match(await detail(), /declare frames.tcp/)
  await runtime.profiles.writeDevice({ description: '', name: 'cup', frames: { tcp: { parent: 'cup:base', translation_m: [0, 0, .05], rotation_xyzw: [0, 0, 0, 1] } } })
  assert.equal(await detail(), 'proportional suction')
  await assert.rejects(runtime.profiles.writeDevice({ description: '', name: 'cup', vacuum: 'on_off' }))
})

test('locomotion modes form a state machine over declared operations and limits', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kinex-locomotion-'))
  const runtime = createKinexRuntime({ directory })
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  await runtime.profiles.writeManifest({ identity: { id: 'dog', name: 'Dog', kind: 'quadruped' } })
  const command = type => ({ description: '', transport: 'topic', direction: 'input', endpoint: `/kinex/dog/${type}`, type: `kinex_interfaces/msg/${type}` })
  const dog = { description: '', name: 'dog', type: 'locomotion', loaded: false, runtime: { nodes: [] },
    operations: { velocity: command('TwistCommand'), posture: command('PoseCommand') },
    velocity: { units: 'si', axes: { vx: { min: -1, max: 1 }, wz: null } },
    posture: { height: { min: -.1, max: .05 } },
    modes: { standing: { description: 'Standing balanced.', accepts: ['velocity', 'posture'], transitions: ['crouched'] },
      crouched: { description: 'Lying down.', accepts: [], transitions: ['standing'] } },
    stop: { behavior: 'hold', affected_devices: ['dog'] }, frames: { base: { parent: null, translation_m: null, rotation_xyzw: null } } }
  for (const [patch, error] of [
    [{ modes: { ...dog.modes, crouched: { ...dog.modes.crouched, transitions: ['walking'] } } }, /walking must be another declared mode/],
    [{ modes: { ...dog.modes, crouched: { ...dog.modes.crouched, accepts: ['gait'] } } }, /gait must be a declared operation/],
    [{ posture: null }, /posture requires declared posture limits/],
    [{ velocity: { units: 'si', axes: { vx: { min: .1, max: 1 } } } }, /include zero/],
  ]) await assert.rejects(runtime.profiles.writeDevice({ ...dog, ...patch }), error)
  await runtime.profiles.writeDevice(dog)
  assert.equal((await runtime.readiness()).items.find(item => item.id === 'profile:dog').detail,
    'modes standing (velocity, posture), crouched; 3 command axes')
})

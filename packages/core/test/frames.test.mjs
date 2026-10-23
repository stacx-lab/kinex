import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Device } from '../dist/device/profile/schema.js'
import { frameErrors } from '../dist/device/profile/frames.js'

const root = () => ({ parent: null, translation_m: null, rotation_xyzw: null })
const frame = parent => ({ parent, translation_m: [0, 0, .1], rotation_xyzw: [0, 0, 0, 1] })
const profile = (frames = {}, name = 'sensor') => ({ description: '', name, type: 'other', frames: { base: root(), ...frames }, meta: { created_at: '', updated_at: '' } })

test('profiles flatten facts', () => {
  const parsed = Device.parse({ ...profile(), type: 'gripper', source: 'user' })
  assert.equal(parsed.source, 'user')
  assert.equal(parsed.grip, '???')
})

test('every frame has an explicit parent; null declares a root regardless of transform', () => {
  assert.ok(Device.safeParse(profile({ base: frame(null) })).success)
  const { parent, ...missingParent } = frame('sensor:base')
  for (const value of [missingParent, frame('base'), frame('sensor'), frame('sensor/base')]) {
    assert.equal(Device.safeParse(profile({ tool: value })).success, false)
  }
  assert.ok(Device.safeParse(profile({ tool: frame('sensor:base'), unknown: { ...root(), parent: 'sensor:tool' } })).success)
  assert.equal(Device.safeParse({ ...profile(), frames: {} }).success, false)
})

test('other devices may omit frames; spatial types and declared frames still need a base', () => {
  const { frames, ...bare } = profile()
  const device = Device.parse(bare)
  assert.equal(device.frames, undefined)
  assert.deepEqual(frameErrors([device]), [])
  assert.equal(Device.safeParse({ ...bare, frames: {} }).success, false)
  assert.equal(Device.safeParse({ ...bare, type: 'rgb' }).success, false)
})

test('frame validation catches local and cross-device missing references and cycles', () => {
  for (const frames of [{ tip: frame('sensor:missing') }, { a: frame('sensor:b'), b: frame('sensor:a') }, { a: frame('sensor:a') }]) {
    assert.equal(Device.safeParse(profile(frames)).success, false)
  }
  const arm = Device.parse(profile({ base: frame('world:base') }, 'arm'))
  const world = Device.parse(profile({}, 'world'))
  assert.deepEqual(frameErrors([arm, world]), [])
  assert.match(frameErrors([arm]).join(), /unknown parent/)
  world.frames.base = frame('arm:base')
  assert.match(frameErrors([arm, world]).join(), /acyclic/)
})

test('URDF links are device frames, checked once the model resolves', async () => {
  const { resolvedTrees } = await import('../dist/device/profile/urdf.js')
  const model = { format: 'urdf', path: 'arm.urdf', base_link: 'base_link', tip_link: 'flange' }
  const arm = Device.parse({ ...profile({ base: frame('world:base'), tool: frame('arm:flange') }, 'arm'), type: 'joint', model })
  const gripper = Device.parse(profile({ base: frame('arm:flange') }, 'gripper'))
  const world = Device.parse(profile({}, 'world'))
  assert.deepEqual(frameErrors([arm, gripper, world]), [])
  resolvedTrees.set(arm.model, { base_link: 'base_link', links: ['base_link', 'flange'], joints: [{ name: 'flange_joint',
    type: 'fixed', parent: 'base_link', child: 'flange', origin: [0, 0, 0, 0, 0, 0, 1] }] })
  assert.deepEqual(frameErrors([arm, gripper, world]), [])
  gripper.frames.base = frame('arm:missing')
  assert.match(frameErrors([arm, gripper, world]).join(), /gripper:base: unknown parent frame arm:missing/)
})

test('flat calibration patches retain requests, validate clears and protect required facts', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { createKinexRuntime } = await import('../dist/index.js')
  const { ProfileStore } = await import('../dist/device/profile/store.js')
  const directory = await mkdtemp(join(tmpdir(), 'kinex-flat-profile-'))
  const runtime = createKinexRuntime({ directory })
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  await runtime.profiles.writeDevice({ ...profile({}, 'world'), type: 'world', loaded: false })
  await runtime.profiles.writeDevice({ ...profile({ base: { ...root(), parent: 'world:base' } }, 'tool'), loaded: false,
    source: 'user', method: 'survey', needs_calibration: 'Measure mounting pose' })
  await assert.rejects(runtime.profiles.writeDevice({ name: 'tool', needs_calibration: null }), /cannot clear profile:tool/)
  await runtime.profiles.writeDevice({ name: 'tool', frames: { base: { translation_m: [0, 0, .2] } } })
  assert.equal((await runtime.devices.list()).find(d => d.name === 'tool').needs_calibration, 'Measure mounting pose')
  await assert.rejects(runtime.profiles.writeDevice({ name: 'tool', needs_calibration: null }), /unknown/)
  await runtime.profiles.writeDevice({ name: 'tool', frames: { base: { rotation_xyzw: [0, 0, 0, 1] } }, needs_calibration: null })
  const tool = (await runtime.devices.list()).find(d => d.name === 'tool')
  assert.equal(tool.source, 'user')
  assert.equal(tool.needs_calibration, null)
  await runtime.operation(async () => {
    await assert.rejects(ProfileStore.writeDevice(directory, { name: 'tool', frames: null }, ['frames']), /cannot remove required/)
    await assert.rejects(ProfileStore.markNeeded(directory, 'mount:tool'), /unknown calibration item/)
  })
  // An unrelated unloaded declaration cannot block this device's valid graph.
  await runtime.profiles.writeDevice({ ...profile({ base: frame('missing:base') }, 'unrelated'), loaded: false })
  await runtime.operation(() => ProfileStore.validateFrames(directory, 'tool'))
  await assert.rejects(runtime.operation(() => ProfileStore.validateFrames(directory, 'unrelated')), /unknown parent/)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Device } from '../dist/device/profile/schema.js'
import { spatialReading } from '../dist/device/spatial.js'
import { deviceFrames } from '../dist/device/profile/frames.js'
import { jointReading } from '../dist/device/joint.js'
import { validateReading, validateWriteResult } from '../dist/device/dispatch.js'

const unknown = () => ({ parent_frame: null, translation_m: null, rotation_xyzw: null })
const frame = parent => ({ parent_frame: parent, translation_m: [0, 0, .1], rotation_xyzw: [0, 0, 0, 1] })
const profile = frames => ({ name: 'sensor', type: 'other', intrinsics: { frames }, meta: { created_at: '', updated_at: '' } })

test('joint models declare frames without placeholders and reject conflicting names', () => {
  const value = { ...profile({}), type: 'joint', intrinsics: {
    kinematics: { frame: 'top', fk: 'driver', ik: null, frame_to_reported: [0, 0, 0, 0, 0, 0, 1] },
  } }
  const device = Device.parse(value)
  assert.deepEqual(device.intrinsics.frames, {})
  assert.deepEqual(deviceFrames(device), { top: { parent_frame: null } })
  assert.ok(Device.safeParse({ ...value, intrinsics: { ...value.intrinsics, frames: { tool: frame('top') } } }).success)
  assert.throws(() => Device.parse({ ...value, intrinsics: { ...value.intrinsics, frames: { top: unknown() } } }), /duplicate/)
  for (const name of ['sensor', 'arm:top']) {
    assert.equal(Device.safeParse({ ...value, intrinsics: { kinematics: { ...value.intrinsics.kinematics, frame: name } } }).success, false)
  }
})

test('local frame definitions allow unknown components and reject missing parents and cycles', () => {
  const value = { flange: unknown(), tool: frame('flange'), partial: { ...unknown(), translation_m: [0, 0, 0] } }
  assert.deepEqual(Device.parse(profile(value)).intrinsics.frames, value)
  for (const frames of [{ tip: frame('missing') }, { a: frame('b'), b: frame('a') }, { a: frame('a') }, { old: null }, { old: [0, 0, 0, 0, 0, 0, 1] }]) {
    assert.equal(Device.safeParse(profile(frames)).success, false)
  }
})

test('unknown sensor transforms do not require read feedback; provided poses must be declared', () => {
  const device = Device.parse(profile({ optional: unknown(), fixed: frame(null) }))
  assert.deepEqual(spatialReading(device, { data: {} }).data, {})
  for (const name of ['missing', 'fixed']) assert.throws(() => spatialReading(device, { data: { frame_poses: { [name]: [0, 0, 0, 0, 0, 0, 1] } } }))
})

test('joint reads reject obsolete frame feedback', () => {
  const device = Device.parse({ ...profile({ flange: unknown() }), type: 'joint', intrinsics: {
    frames: { flange: unknown() }, model: { format: 'joints', joints: [
      { name: 'j', type: 'revolute', limits: { min: -1, max: 1 }, max_velocity: null, max_effort: null },
    ] }, feedback: { velocities: false, efforts: false },
  } })
  const data = { positions: [1.01], velocities: [], efforts: [], faults: [], timestamp: 1 }
  assert.deepEqual(jointReading(device, spatialReading(device, { data })).data, data)
  assert.throws(() => jointReading(device, { data: { ...data, frame_poses: {} } }))
})


test('gripper reads and write states reject removed fields and validate physical aperture', () => {
  const base = profile({ tcp: frame(null) })
  const device = Device.parse({ ...base, type: 'gripper', intrinsics: { ...base.intrinsics, feedback: { aperture_m: true } } })
  const data = { aperture_m: .04, faults: [], timestamp: 1 }
  const write = state => ({ data: { execution_id: 'submission', state } })
  assert.deepEqual(validateReading(device, { data }).data, data)
  assert.deepEqual(validateWriteResult(device, write(data)), write(data))
  for (const extra of [
    { frame_poses: {} }, { positions: [] }, { velocities: [] },
    { force_n: null }, { pressure_pa: null }, { object_detected: null },
    { aperture_m: null }, { aperture_m: -1 }, { aperture_m: true },
    { timestamp: undefined }, { faults: [{ message: 'bad' }] },
  ]) {
    assert.throws(() => validateReading(device, { data: { ...data, ...extra } }))
    assert.throws(() => validateWriteResult(device, write({ ...data, ...extra })))
  }
  assert.throws(() => validateWriteResult(device, { data: { ...write(data).data, elapsed_s: 0 } }))
  assert.throws(() => validateWriteResult(device, write({ ...data, faults: [{ code: 'jammed' }] })))
  device.intrinsics.feedback.aperture_m = false
  assert.equal(validateReading(device, { data: { ...data, aperture_m: null } }).data.aperture_m, null)
  assert.throws(() => validateReading(device, { data }))
})

test('velocity reads and write states retain body feedback but reject global pose', () => {
  const device = Device.parse({ ...profile({ torso: unknown() }), type: 'velocity', intrinsics: {
    frames: { torso: unknown() }, feedback: { velocity_frame: 'body', velocity_components: ['vx', 'vy', 'wz'] },
  } })
  const data = { velocities: [.1, 0, 0], faults: [], timestamp: 2, height_m: .74,
    frame_poses: { torso: [0, 0, .2, 0, 0, 0, 1] } }
  const write = state => ({ data: { execution_id: 'submission', state } })
  assert.deepEqual(validateReading(device, { data }).data, data)
  assert.deepEqual(validateWriteResult(device, write(data)), write(data))
  for (const extra of [{ pose: null }, { pose: { translation_m: [1, 2, 0], rotation_xyzw: [0, 0, 0, 1] } },
    { velocities: [0] }, { velocities: [NaN, 0, 0] }, { timestamp: Infinity }, { height_m: NaN },
    { frame_poses: { missing: [0, 0, 0, 0, 0, 0, 1] } }]) {
    assert.throws(() => validateReading(device, { data: { ...data, ...extra } }))
    assert.throws(() => validateWriteResult(device, write({ ...data, ...extra })))
  }
  const { frame_poses, ...body } = data
  assert.deepEqual(validateReading(device, { data: body }).data, body)
  assert.deepEqual(validateReading(device, { data: { ...body, frame_poses: {} } }).data, body)
  assert.throws(() => Device.parse({ ...device, intrinsics: { ...device.intrinsics, feedback: { ...device.intrinsics.feedback, pose_frame: 'world' } } }))
  assert.throws(() => Device.parse({ ...device, extrinsics: { pose_frame: 'world' } }))
  assert.throws(() => Device.parse({ ...device, extrinsics: { mount: { parent: 'world', parent_frame: null, translation_m: [0, 0, 0], rotation_xyzw: [0, 0, 0, 1] } } }))
})

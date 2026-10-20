import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Device } from '../dist/device/profile/schema.js'
import { deviceFrames } from '../dist/device/profile/frames.js'

const unknown = () => ({ parent_frame: null, translation_m: null, rotation_xyzw: null })
const frame = parent => ({ parent_frame: parent, translation_m: [0, 0, .1], rotation_xyzw: [0, 0, 0, 1] })
const profile = frames => ({ description: '', name: 'sensor', type: 'other', intrinsics: { frames }, meta: { created_at: '', updated_at: '' } })

test('joint models declare frames without placeholders and reject conflicting names', () => {
  const value = { ...profile({}), type: 'joint', intrinsics: {
    kinematics: { frame: 'top', fk: 'driver', ik: null, frame_to_reported: [0, 0, 0, 0, 0, 0, 1] },
  } }
  const device = Device.parse(value)
  assert.deepEqual(device.intrinsics.frames, {})
  assert.deepEqual(deviceFrames(device), { top: { parent_frame: null } })
  assert.ok(Device.safeParse({ description: '', ...value, intrinsics: { ...value.intrinsics, frames: { tool: frame('top') } } }).success)
  assert.throws(() => Device.parse({ description: '', ...value, intrinsics: { ...value.intrinsics, frames: { top: unknown() } } }), /duplicate/)
  for (const name of ['sensor', 'arm:top']) {
    assert.equal(Device.safeParse({ description: '', ...value, intrinsics: { kinematics: { ...value.intrinsics.kinematics, frame: name } } }).success, false)
  }
})

test('local frame definitions allow unknown components and reject missing parents and cycles', () => {
  const value = { flange: unknown(), tool: frame('flange'), partial: { ...unknown(), translation_m: [0, 0, 0] } }
  assert.deepEqual(Device.parse(profile(value)).intrinsics.frames, value)
  for (const frames of [{ tip: frame('missing') }, { a: frame('b'), b: frame('a') }, { a: frame('a') }, { old: null }, { old: [0, 0, 0, 0, 0, 0, 1] }]) {
    assert.equal(Device.safeParse(profile(frames)).success, false)
  }
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Device, deviceHome } from '../dist/device/profile/schema.js'
import { writeCommand } from '../dist/device/command.js'

const meta = { created_at: '2026-09-29T00:00:00Z', updated_at: '2026-09-29T00:00:00Z' }
const joint = native => Device.parse({ meta, name: 'arm', type: 'joint', intrinsics: {
  model: { format: 'joints', joints: [{ name: 'j', type: 'revolute', limits: { min: -1, max: 1 }, max_velocity: null, max_effort: null }] },
  control: { mode: 'position', ...(native ? { limit_handling: 'native' } : {}) },
} })

test('joint home recovery uses a fixed one-degree inward prefix and plain home maps', () => {
  const device = joint(false)
  assert.throws(() => Device.parse({ ...device, intrinsics: { ...device.intrinsics, has_brake: false } }), /Unrecognized key/)
  device.intrinsics.home = { j: 0 }
  assert.deepEqual(deviceHome(Device.parse(device)), [0])
  for (const home of [{ joints: { j: 0 } }, {}, { j: 2 }, { j: 0, tolerance_deg: 1 }])
    assert.throws(() => Device.parse({ ...device, intrinsics: { ...device.intrinsics, home } }))
  assert.throws(() => Device.parse({ ...device, intrinsics: { ...device.intrinsics, home_start_tolerance_deg: 1 } }), /Unrecognized key/)
  const check = actions => writeCommand(device, { actions: actions.map(q => [q]), duration_s: 1 })
  for (const sign of [-1, 1]) {
    check([sign * (1 + Math.PI / 180), sign * 1.004, sign, 0])
    assert.throws(() => check([sign * (1 + 1.01 * Math.PI / 180), 0]), /joint limits/)
  }
  for (const actions of [[1.09, 0], [1.004, 1.005, 0], [1.004, .9, 1.001, 0], [1.004, .1], [1.004]])
    assert.throws(() => check(actions), /joint limits/)
  for (const home of [null, '???']) {
    device.intrinsics.home = home
    assert.throws(() => check([1.004, 0]))
  }
  device.intrinsics.home = { j: 0 }
  device.type = 'dexterous_hand'
  assert.throws(() => check([1.004, 0]))
  device.type = 'joint'
  device.intrinsics.model.joints[0].type = 'prismatic'
  assert.throws(() => check([1.001, 0]))
})

test('native joint writes delegate range handling but retain finite dimensions and command shape', () => {
  const args = { actions: [[100]], duration_s: .1 }
  assert.throws(() => writeCommand(joint(false), args))
  assert.deepEqual(writeCommand(joint(true), args), args)
  for (const target of [[true], [NaN], [Infinity], [], [1, 2]])
    assert.throws(() => writeCommand(joint(true), { ...args, actions: [[0], target] }))
  assert.throws(() => writeCommand(joint(true), { ...args, extra: true }))
})

test('gripper profiles reject out-of-range commands and preserve direction normalization', () => {
  for (const control of [
    { mode: 'position', units: 'normalized', bounds: { min: 0, max: 1 }, resolution: null, open_target: 1, close_target: 0, speed: null },
    { mode: 'direction', open_target: -1, close_target: 1 },
  ]) {
    const device = Device.parse({ meta, name: 'gripper', type: 'gripper', intrinsics: { control } })
    const low = control.mode === 'position' ? 0 : -1
    assert.deepEqual(writeCommand(device, { actions: [low, 0, 1], duration_s: .1 }).actions, [low, 0, 1])
    for (const value of [low - 1e-6, 1 + 1e-6, NaN, Infinity, true])
      assert.throws(() => writeCommand(device, { actions: [0, value], duration_s: .1 }))
    if (control.mode === 'direction')
      assert.deepEqual(writeCommand(device, { actions: [-.3, 0, .3], duration_s: .1 }).actions, [-1, 0, 1])
  }
})

test('native velocity and posture pass through with null or documented bounds', () => {
  for (const bounds of [null, { min: -1, max: 1 }]) {
    const device = Device.parse({ meta, name: 'base', type: 'velocity', intrinsics: { control: {
      mode: 'motion', body_frame: 'base', limit_handling: 'native', modes: { drive: {
        velocity: { frame: 'body', components: [{ axis: 'vx', units: 'm/s', bounds }] },
        posture: { reference: 'ground', components: [{ axis: 'height', units: 'm', bounds: null, default: .7 }] },
      } },
    } } })
    const args = { mode: 'drive', velocity: { vx: 100 }, posture: { height: 100 }, duration_s: .1 }
    assert.deepEqual(writeCommand(device, args), args)
    assert.throws(() => writeCommand(device, { ...args, velocity: [0] }), /velocity requires named axes.*vx.*arrays are unsupported/)
    assert.throws(() => writeCommand(device, { ...args, posture: [.7] }), /posture requires named axes.*height/)
    for (const duration_s of [0, -1, NaN, Infinity, true]) assert.throws(() => writeCommand(device, { ...args, duration_s }))
    for (const velocity of [{ vx: true }, { vx: NaN }, {}, { vx: 0, vy: 0 }])
      assert.throws(() => writeCommand(device, { ...args, velocity }))
  }
})


test('gripper profiles allow finger descriptions and reject removed contact and feedback fields', () => {
  const profile = { meta, name: 'gripper', type: 'gripper', intrinsics: {
    feedback: { aperture_m: true },
    frames: { tcp: { parent_frame: null, translation_m: [0, 0, .097], rotation_xyzw: [0, 0, 0, 1] } },
  } }
  assert.equal(Device.parse(profile).intrinsics.feedback.aperture_m, true)
  for (const [key, value] of Object.entries({ sensors: [], clock: 'simulation', positions: [], velocities: false, aperture_model: null }))
    assert.throws(() => Device.parse({ ...profile, intrinsics: { ...profile.intrinsics, feedback: { ...profile.intrinsics.feedback, [key]: value } } }))
  const geometry = { description: 'Two opposing sliding fingers.', approach_axis: null, closing_axis: null }
  assert.equal(Device.parse({ ...profile, intrinsics: { ...profile.intrinsics, geometry } }).intrinsics.geometry.description, geometry.description)
  assert.throws(() => Device.parse({ ...profile, intrinsics: { ...profile.intrinsics, geometry: { ...geometry, contacts: {} } } }))
})

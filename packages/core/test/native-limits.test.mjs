import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Device } from '../dist/device/profile/schema.js'
import { writeCommand } from '../dist/device/command.js'

const meta = { created_at: '2026-09-29T00:00:00Z', updated_at: '2026-09-29T00:00:00Z' }
const joint = native => Device.parse({ meta, name: 'arm', type: 'joint', intrinsics: {
  model: { format: 'joints', joints: [{ name: 'j', type: 'revolute', limits: { min: -1, max: 1 }, max_velocity: null, max_effort: null }] },
  control: { mode: 'position', ...(native ? { limit_handling: 'native' } : {}) },
} })

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
    { mode: 'direction', open_target: -1, close_target: 1, increment_per_interval: .2 },
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
    for (const velocity of [{ vx: true }, { vx: NaN }, {}, { vx: 0, vy: 0 }])
      assert.throws(() => writeCommand(device, { ...args, velocity }))
  }
})

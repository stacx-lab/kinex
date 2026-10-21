import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Device, deviceHome } from '../dist/device/profile/schema.js'

const meta = { created_at: '2026-09-29T00:00:00Z', updated_at: '2026-09-29T00:00:00Z' }
const joint = native => Device.parse({ description: '',
  meta,
  name: 'arm',
  type: 'joint',
  model: { format: 'joints', joints: [{ name: 'j', type: 'revolute', limits: { min: -1, max: 1 }, max_velocity: null, max_effort: null }] },
  control: { mode: 'position', ...(native ? { limit_handling: 'native' } : {}) },
  frames: { base: {parent: null, translation_m: null, rotation_xyzw: null} } })

test('joint home recovery uses a fixed one-degree inward prefix and plain home maps', () => {
  const device = joint(false)
  assert.throws(() => Device.parse({ description: '',
    ...device,
    has_brake: false }), /Unrecognized key/)
  device.home = { j: 0 }
  assert.deepEqual(deviceHome(Device.parse(device)), [0])
  for (const home of [{ joints: { j: 0 } }, {}, { j: 2 }, { j: 0, tolerance_deg: 1 }])
    assert.throws(() => Device.parse({ description: '',
      ...device,
      home }))
  assert.throws(() => Device.parse({ description: '',
    ...device,
    home_start_tolerance_deg: 1 }), /Unrecognized key/)
})

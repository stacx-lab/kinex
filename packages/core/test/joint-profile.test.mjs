import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Device, deviceActions, deviceJoints } from '../dist/device/profile/schema.js'
import { jointErrors } from '../dist/device/profile/joint.js'
import { resolvedTrees } from '../dist/device/profile/urdf.js'

const meta = { created_at: '2026-09-29T00:00:00Z', updated_at: '2026-09-29T00:00:00Z' }
const origin = [0, 0, 0, 0, 0, 0, 1]
const movable = (name, child, mimic = null) => ({ name, type: 'revolute', parent: 'base_link', child, origin,
  axis: [0, 0, 1], limits: { min: -1, max: 1 }, max_velocity: null, max_effort: null, mimic })
const tree = { base_link: 'base_link', links: ['base_link', 'tip', 'twin'],
  joints: [movable('j', 'tip'), movable('twin', 'twin', { joint: 'j', multiplier: 1, offset: 0 })] }
const joint = Device.parse({ description: '', meta, name: 'arm', type: 'joint',
  model: { format: 'urdf', path: 'arm.urdf', base_link: 'base_link', tip_link: 'tip' },
  frames: { base: { parent: null, translation_m: null, rotation_xyzw: null } } })

test('joint limits default to strict', () => {
  assert.equal(joint.limits, 'strict')
  assert.equal(Device.parse({ ...joint, limits: 'native' }).limits, 'native')
  assert.throws(() => Device.parse({ ...joint, limits: 'clamp' }))
})

test('the URDF tree defines commanded joints, home and tip_link', () => {
  assert.deepEqual(jointErrors({ ...joint, home: { j: 0 } }, tree), [])
  for (const home of [{}, { j: 2 }, { j: 0, twin: 0 }])
    assert.notDeepEqual(jointErrors({ ...joint, home }, tree), [], JSON.stringify(home))
  for (const tip_link of ['base_link', 'missing', 'twin'])
    assert.match(jointErrors({ ...joint, model: { ...joint.model, tip_link } }, tree)[0], /tip_link/)
  const device = Device.parse({ ...joint, home: { j: 0 } })
  assert.deepEqual(deviceJoints(device), [])
  resolvedTrees.set(device.model, tree)
  assert.deepEqual(deviceJoints(device).map(item => item.name), ['j'])
  assert.deepEqual(deviceActions(device), [{ joint: 'j', units: 'rad', bounds: { min: -1, max: 1 } }])
})

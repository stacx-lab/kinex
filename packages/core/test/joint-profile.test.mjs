import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Device, deviceActions, deviceJoints } from '../dist/device/profile/schema.js'
import { jointErrors } from '../dist/device/profile/joint.js'
import { resolvedTrees } from '../dist/device/profile/urdf.js'

const meta = { created_at: '2026-09-29T00:00:00Z', updated_at: '2026-09-29T00:00:00Z' }
const origin = [0, 0, 0, 0, 0, 0, 1]
const movable = (name, child, mimic = null) => ({ name, type: 'revolute', parent: 'base_link', child, origin,
  axis: [0, 0, 1], limits: { min: -1, max: 1 }, max_velocity: null, max_effort: null, mimic })
const fixed = (name, parent, child) => ({ name, type: 'fixed', parent, child, origin })
const tree = { base_link: 'base_link', links: ['base_link', 'tip', 'twin', 'thumb', 'pad'],
  joints: [movable('j', 'tip'), movable('twin', 'twin', { joint: 'j', multiplier: 1, offset: 0 }),
    movable('k', 'thumb'), fixed('pad_joint', 'thumb', 'pad')] }
const joint = Device.parse({ description: '', meta, name: 'arm', type: 'joint',
  model: { format: 'urdf', path: 'arm.urdf', base_link: 'base_link', tip_links: ['tip'] },
  frames: { base: { parent: null, translation_m: null, rotation_xyzw: null } } })

test('joint limits default to strict', () => {
  assert.equal(joint.limits, 'strict')
  assert.equal(Device.parse({ ...joint, limits: 'native' }).limits, 'native')
  assert.throws(() => Device.parse({ ...joint, limits: 'clamp' }))
})

test('the URDF tree defines commanded joints, home and tip_links', () => {
  const home = { j: 0, k: 0 }
  assert.deepEqual(jointErrors({ ...joint, home }, tree), [])
  for (const wrong of [{}, { j: 2, k: 0 }, { ...home, twin: 0 }])
    assert.notDeepEqual(jointErrors({ ...joint, home: wrong }, tree), [], JSON.stringify(wrong))
  const tips = tip_links => jointErrors({ ...joint, model: { ...joint.model, tip_links } }, tree)
  assert.deepEqual(tips(['tip', 'pad']), [])
  assert.deepEqual(tips([]), [])
  for (const tip of ['base_link', 'missing', 'twin'])
    assert.match(tips([tip])[0], /tip_links/)
  assert.deepEqual(tips(['thumb', 'pad']), ['tip_links thumb lies on the chain of pad'])
  assert.throws(() => Device.parse({ ...joint, model: { ...joint.model, tip_links: ['tip', 'tip'] } }), /duplicate tip link/)
  const device = Device.parse({ ...joint, home })
  assert.deepEqual(deviceJoints(device), [])
  resolvedTrees.set(device.model, tree)
  assert.deepEqual(deviceJoints(device).map(item => item.name), ['j', 'k'])
  assert.deepEqual(deviceActions(device), ['j', 'k'].map(joint => ({ joint, units: 'rad', bounds: { min: -1, max: 1 } })))
})

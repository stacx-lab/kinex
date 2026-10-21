import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKinexRuntime } from '../dist/index.js'
import { ProfileStore } from '../dist/device/profile/store.js'
import { Device } from '../dist/device/profile/schema.js'
import { deviceFrames } from '../dist/device/profile/frames.js'
import { handJointErrors } from '../dist/device/profile/hand.js'

const identity = [0, 0, 0, 0, 0, 0, 1]
const joint = name => ({ name, type: 'revolute', limits: { min: -1, max: 1 }, max_velocity: null, max_effort: null })
const link = name => ({ joint: name, origin: identity, axis: [0, 0, 1], anchor: [0, 0, 0], reference: 0 })
const finger = (tip_frame = 'tip') => ({ chain: [link('j')], tip_frame, tip_offset: identity })
const center = { frame: 'center', weights: { index: 1 }, rotation_xyzw: [0, 0, 0, 1] }
const root = { parent: null, translation_m: null, rotation_xyzw: null }
const moving = { ...root, parent: 'hand:base' }
const profile = geometry => ({ description: '', name: 'hand', type: 'dexterous_hand', meta: { created_at: '', updated_at: '' },
  model: { format: 'joints', joints: [joint('j'), joint('k')] }, ...(geometry === undefined ? {} : { geometry }),
  frames: { base: root, ...Object.fromEntries([
    ...Object.values(geometry?.fingers ?? {}).map(f => f.tip_frame), ...(geometry?.center ? [geometry.center.frame] : [])
  ].map(name => [name, moving])) },
})

test('hand descriptions and executable geometry advertise only available frames and FK', () => {
  for (const geometry of [undefined, { description: 'Three fingers.' }]) {
    const device = Device.parse(profile(geometry))
    assert.deepEqual(deviceFrames(device), {base: root})
  }
  for (const extra of [{}, { center }]) {
    const device = Device.parse(profile({ fingers: { index: finger(), thumb: finger('thumb_tip') }, ...extra }))
    assert.deepEqual(Object.keys(deviceFrames(device)), ['base', 'tip', 'thumb_tip', ...(extra.center ? ['center'] : [])])
  }
  const value = profile({ description: 'No finger geometry.' })
  value.kinematics = { frame: 'endpoint', fk: 'driver', ik: null, frame_to_reported: identity }
})

test('named finger chains validate references and reject obsolete or ambiguous profiles', () => {
  const valid = { fingers: { index: finger() } }
  const variants = [
    {}, { description: '' }, { fingers: {} }, { description: 'Hand.', center },
    { ...valid, palm_frame: 'palm' }, { ...valid, reference_frame: 'reference' },
    { fingers: { index: { ...finger(), joints: ['j'] } } },
    ...[[link(0)], [link('missing')], [link('j'), link('j')], [{ origin: identity }],
      [{ ...link('j'), axis: [0, 0, 2] }], [{ ...link('j'), origin: [0, 0, 0, 0, 0, 0, 2] }]]
      .map(chain => ({ fingers: { index: { ...finger(), chain } } })),
    { ...valid, center: { ...center, weights: { missing: 1 } } },
    { ...valid, center: { ...center, weights: { index: .5 } } },
    { ...valid, center: { ...center, weights: { index: -1, thumb: 2 } } },
    { ...valid, center: { ...center, frame: 'tip' } },
    { fingers: { index: finger(), thumb: finger() } },
    { fingers: { index: finger('hand:tip') } },
  ]
  for (const geometry of variants) assert.equal(Device.safeParse(profile(geometry)).success, false, JSON.stringify(geometry))
  const value = profile(valid)
  value.frames = { tip: { parent: "hand:base", translation_m: [0, 0, 0], rotation_xyzw: [0, 0, 0, 1] } }
  assert.equal(Device.safeParse(value).success, false)
  const chain = [link('k'), { origin: identity }, link('j')]
  assert.ok(Device.safeParse(profile({ fingers: { index: { ...finger(), chain } } })).success)
})

test('URDF hand references are checked against the resolved model', () => {
  const value = profile({ fingers: { index: finger() } })
  value.model = { format: 'urdf', path: 'hand.urdf', base_link: 'base', tip_link: 'tip' }
  const geometry = Device.parse(value).geometry
  assert.deepEqual(handJointErrors(geometry, { joints: [joint('j')], chain: null }), [])
  assert.deepEqual(handJointErrors(geometry, { joints: [joint('k')], chain: null }), ['finger index references unknown model joint j'])
})

test('runtime context describes hands without inventing prediction capabilities', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kinex-hand-context-'))
  const runtime = createKinexRuntime({ directory })
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  await runtime.profiles.writeManifest({ identity: { id: 'hands', name: 'Hands', kind: 'arm', platform: 'real' } })
  for (const geometry of [{ description: 'Three opposed fingers.' }, { fingers: { index: finger() } }, { fingers: { index: finger() }, center }]) {
    await runtime.operation(() => ProfileStore.writeDevice(directory, profile(geometry), ['geometry', 'frames']))
    const context = (await runtime.context()).robotics
    assert.match(context, /hand \(dexterous_hand\)/)
    assert.doesNotMatch(context, /Three opposed fingers|local fingertip prediction|predicted center/)
    assert.doesNotMatch(context, /fixed grasp reference/)
  }
})

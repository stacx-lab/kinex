import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createKinexRuntime, PermissionDeniedError } from '@kinex/core'
import { createKinexSetup, setupSkillRoots, setupToolNames } from '../dist/index.js'

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kinex-plan-'))
  const runtime = createKinexRuntime({ directory, builtinSkillRoots: setupSkillRoots, reservedToolNames: setupToolNames,
    host: { ask: async () => {} } })
  const setup = createKinexSetup(runtime)
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  const evidence = async (name = 'source.txt', text = 'Measured or factory evidence') => {
    await mkdir(path.join(directory, '.kinex/evidence'), { recursive: true })
    await writeFile(path.join(directory, '.kinex/evidence', name), text)
    return `evidence/${name}`
  }
  const save = async (nodes, targets = [], facts = []) => setup.plan.save({ version: 1, nodes,
    task: { objective: 'Current task', targets, facts } }, (await setup.plan.inspect()).revision)
  const done = async (node, file = 'evidence/source.txt') => setup.plan.record(node,
    { status: 'done', note: 'Verified against archived evidence', evidence: [file] }, (await setup.plan.inspect()).revision)
  return { directory, runtime, setup, evidence, save, done }
}
const fact = (device, pointer, value) => ({ kind: 'profile', device, pointer, ...(value === undefined ? {} : { value }) })
const node = (id, extra = {}) => ({ id, title: id, kind: 'prepare', skill: 'setup-device', ...extra })

test('planning is inert without a plan, even with URDF descriptions; operations need no plan', async t => {
  const { setup, runtime, directory } = await fixture(t)
  assert.equal((await setup.plan.inspect()).taskSatisfied, null)
  await assert.rejects(stat(path.join(directory, '.kinex')), { code: 'ENOENT' })
  await mkdir(path.join(directory, '.kinex/devices/arm'), { recursive: true })
  await writeFile(path.join(directory, '.kinex/devices/arm/profile.yaml'), 'name: arm\ntype: joint\nintrinsics:\n  model:\n    format: urdf\n    path: missing.urdf\n    base_link: base\n    tip_link: tip\n')
  await setup.plan.save({ version: 1, nodes: [node('inspect', { inputs: [fact('arm', '/intrinsics/model/path')] })], task: null }, 0)
  assert.equal((await setup.plan.inspect()).next.length, 0)
  await assert.rejects(stat(path.join(directory, '.kinex/python')), { code: 'ENOENT' })
  assert.ok((await runtime.tools.list()).tools.some(tool => tool.name === 'device'))
})

test('only task targets and ancestors advance; no global calibration gate', async t => {
  const { runtime, setup, save, evidence, done } = await fixture(t)
  await runtime.profiles.writeManifest({ identity: { id: 'robot', name: 'Robot', kind: 'arm', platform: 'real' } })
  await runtime.profiles.writeDevice({ name: 'sensor', type: 'other', access: { connection: { kind: 'mock' } } })
  await runtime.profiles.writeDevice({ name: 'camera', type: 'rgb', loaded: true })
  await runtime.profiles.writeDevice({ name: 'right_arm', type: 'joint', loaded: true })
  await evidence()
  await save([node('sensor-access', { outputs: [fact('sensor', '/access/connection/kind', 'mock')] }),
    node('camera-geometry', { inputs: [fact('camera', '/intrinsics/color')] }),
    node('right-arm-model', { inputs: [fact('right_arm', '/intrinsics/model')] }),
    node('optional-survey', { optional: true })], ['sensor-access'])
  assert.deepEqual((await setup.plan.inspect()).next, ['sensor-access'])
  await done('sensor-access')
  const view = await setup.plan.inspect()
  assert.equal(view.taskSatisfied, true)
  assert.deepEqual(view.next, [])
  assert.equal(view.nodes.find(node => node.id === 'camera-geometry').relevance, 'deferred')
  await (await runtime.devices.load('sensor')).ready
  assert.ok(!(await runtime.tools.call('device', { deviceID: 'sensor', action: 'read' }, { sessionID: 'task' })).isError)
  const result = await setup.tools.call('setup_plan', { action: 'read' }, { sessionID: 'task' })
  assert.deepEqual(JSON.parse(result.output).nodes, [])
})

test('reject cycles, missing dependencies, wrong task targets and stale revisions', async t => {
  const { save, setup } = await fixture(t)
  await assert.rejects(save([node('a', { dependsOn: ['b'] }), node('b', { dependsOn: ['a'] })]), /a -> b -> a/)
  await assert.rejects(save([node('a', { dependsOn: ['missing'] })]), /Unknown dependency/)
  await assert.rejects(save([node('a')], ['missing']), /Unknown task target/)
  await save([node('a')], ['a'])
  await assert.rejects(setup.plan.save({ version: 1, nodes: [], task: null }, 0), /Plan changed/)
  await setup.plan.select(null, 1)
  assert.deepEqual((await setup.plan.inspect()).next, [])
})

test('facts, evidence and transitive dependencies invalidate only affected branches', async t => {
  const { runtime, setup, save, evidence, done } = await fixture(t)
  await runtime.profiles.writeDevice({ name: 'arm', type: 'joint', intrinsics: { frames: { tcp: [0, 0, 0, 0, 0, 0, 1] } } })
  await evidence()
  await save([node('tcp', { outputs: [fact('arm', '/intrinsics/frames/tcp')] }),
    node('reach', { dependsOn: ['tcp'] }), node('independent')], ['reach'])
  await assert.rejects(done('reach'), /prerequisites/)
  await done('tcp'); await done('reach'); await done('independent')
  assert.equal((await setup.plan.inspect()).taskSatisfied, true)
  await runtime.profiles.writeDevice({ name: 'arm', loaded: true })
  assert.equal((await setup.plan.inspect()).taskSatisfied, true)
  await runtime.profiles.writeDevice({ name: 'arm', intrinsics: { frames: { tcp: [0.1, 0, 0, 0, 0, 0, 1] } } })
  const states = Object.fromEntries((await setup.plan.inspect()).nodes.map(node => [node.id, node.status]))
  assert.deepEqual(states, { tcp: 'stale', reach: 'stale', independent: 'done' })
  await done('tcp')
  assert.equal((await setup.plan.inspect()).nodes.find(node => node.id === 'reach').status, 'stale')
  await setup.plan.select({ objective: 'Independent task', targets: ['independent'], facts: [] }, (await setup.plan.inspect()).revision)
  assert.equal((await setup.plan.inspect()).taskSatisfied, true)
  await evidence('source.txt', 'Changed evidence')
  assert.equal((await setup.plan.inspect()).nodes.find(node => node.id === 'independent').status, 'stale')
})

test('partial TCP facts can satisfy a task while rotation and section request remain unknown', async t => {
  const { runtime, setup, save } = await fixture(t)
  await runtime.profiles.writeDevice({ name: 'tool', type: 'gripper', extrinsics: { needs_calibration: 'orientation unknown',
    mount: { parent: 'arm', parent_frame: 'flange', translation_m: [0, 0, .1], rotation_xyzw: '???' } } })
  await save([], [], [fact('tool', '/extrinsics/mount/translation_m')])
  assert.equal((await setup.plan.inspect()).taskSatisfied, true)
  await setup.plan.select({ objective: 'Full pose', targets: [], facts: [fact('tool', '/extrinsics/mount/rotation_xyzw')] }, 1)
  assert.equal((await setup.plan.inspect()).taskSatisfied, false)
  assert.equal((await runtime.devices.list()).find(device => device.name === 'tool').extrinsics.needs_calibration, 'orientation unknown')
})

test('dual-arm prerequisites bind both particular TCPs, with producer dependencies', async t => {
  const { runtime, save, setup } = await fixture(t)
  for (const name of ['left', 'right']) await runtime.profiles.writeDevice({ name, type: 'joint' })
  for (const [name, parent] of [['lt', 'left'], ['rt', 'right'], ['unrelated', 'left']])
    await runtime.profiles.writeDevice({ name, type: 'gripper', extrinsics: { mount: { parent, parent_frame: 'flange',
      translation_m: name === 'rt' ? '???' : [0, 0, .1], rotation_xyzw: [0, 0, 0, 1] } } })
  const dual = node('dual', { kind: 'calibrate', skill: 'calibrate-dual-arm',
    bindings: { anchor: 'left', second: 'right', anchor_tcp: 'lt', second_tcp: 'rt' } })
  await save([dual], ['dual'])
  assert.equal((await setup.plan.inspect()).nodes[0].status, 'needs-input')
  await assert.rejects(save([{ ...dual, bindings: { ...dual.bindings, second_tcp: 'unrelated' } }], ['dual']), /attached to left/)
  await assert.rejects(save([dual, node('rt-translation', { outputs: [fact('rt', '/extrinsics/mount/translation_m')] })], ['dual']), /missing dependency/)
})

test('a usable base mode is not blocked by unknown bounds in an unused mode', async t => {
  const { runtime, save, setup } = await fixture(t)
  const drive = { velocity: { frame: 'body', components: [{ axis: 'vx', units: 'm/s', bounds: null }] }, posture: null }
  const unused = { velocity: { frame: 'body', components: [{ axis: 'wz', units: 'rad/s', bounds: '???' }] }, posture: null }
  await runtime.profiles.writeDevice({ name: 'base', type: 'velocity', intrinsics: {
    control: { mode: 'motion', body_frame: 'base', modes: { drive, unused } },
    feedback: { clock: 'simulation', pose_frame: null, velocity_frame: 'base', velocity_components: ['vx'] },
    stop: { behavior: 'halt', affected_devices: ['base'] },
  } })
  await save([node('drive-check', { kind: 'verify', skill: 'verify-base-motion', bindings: { base: 'base' },
    inputs: [fact('base', '/intrinsics/control/modes/drive')] })], ['drive-check'])
  assert.deepEqual((await setup.plan.inspect()).next, ['drive-check'])
  assert.equal((await runtime.devices.list())[0].intrinsics.control.modes.unused.velocity.components[0].bounds, '???')
})

test('workspace skill override supplies the selected procedure and malformed deferred skills do not gate tasks', async t => {
  const { directory, runtime, setup, save } = await fixture(t)
  const dir = path.join(directory, '.kinex/skill/calibrate-tcp-offset')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'SKILL.md'), '---\nname: calibrate-tcp-offset\ndescription: Local procedure\n---\nUse local data.\n')
  await writeFile(path.join(dir, 'procedure.json'), JSON.stringify({ version: 1, roles: { probe: { types: ['other'] } }, quality: 'Local evidence' }))
  await runtime.profiles.writeDevice({ name: 'probe', type: 'other' })
  await save([node('custom', { skill: 'calibrate-tcp-offset', bindings: { probe: 'probe' } })], [])
  assert.equal((await setup.plan.inspect()).procedures.find(p => p.name === 'calibrate-tcp-offset').directory, dir)
  await writeFile(path.join(dir, 'procedure.json'), '{bad json')
  await setup.plan.select({ objective: 'Unrelated task', targets: [], facts: [] }, 1)
  assert.equal((await setup.plan.inspect()).taskSatisfied, true)
  assert.equal((await setup.plan.inspect()).nodes[0].status, 'needs-input')
})

test('plan writes retain host permissions and cancellation', async t => {
  const { setup, directory } = await fixture(t)
  const input = { action: 'save', revision: 0, plan: { version: 1, nodes: [] } }
  await assert.rejects(setup.tools.call('setup_plan', input, { sessionID: 'denied', ask: async ({ permission }) => {
    throw new PermissionDeniedError(permission)
  } }), PermissionDeniedError)
  await assert.rejects(stat(path.join(directory, '.kinex')), { code: 'ENOENT' })
  const controller = new AbortController(); controller.abort()
  await assert.rejects(setup.plan.save({ version: 1, nodes: [], task: null }, 0).then(async () => {
    // A fresh invocation with an already-aborted signal cannot mutate the plan.
    await setup.tools.call('setup_plan', { ...input, revision: 1 }, { sessionID: 'cancelled', signal: controller.signal })
  }))
  assert.equal(JSON.parse(await readFile(path.join(directory, '.kinex/setup/plan.json'))).revision, 1)
})

test('reference compositions preserve moving attachments without forcing world calibration', async t => {
  const { runtime, save, setup, evidence, done } = await fixture(t)
  const compositions = [
    { kind: 'arm', parent: 'world', frame: 'world', arms: ['arm'], tools: ['gripper'] },
    { kind: 'other', parent: 'world', frame: 'world', arms: ['left_arm', 'right_arm'], tools: ['left_gripper', 'right_gripper'] },
    { kind: 'mobile', parent: 'torso', frame: 'top', arms: ['arm'], tools: ['gripper'] },
    { kind: 'quadruped', parent: 'base', frame: 'base', arms: ['arm'], tools: ['gripper'] },
    { kind: 'mobile', parent: 'trunk', frame: 'flange', arms: ['left_arm', 'right_arm'], tools: ['left_gripper', 'right_gripper'] },
    { kind: 'humanoid', parent: 'base', frame: 'torso', arms: ['left_arm', 'right_arm'], tools: ['left_hand', 'right_hand'] },
  ]
  await evidence()
  for (const composition of compositions) {
    await runtime.profiles.writeManifest({ identity: { id: composition.kind, name: composition.kind, platform: 'sim', kind: composition.kind } })
    await runtime.profiles.writeDevice({ name: 'world', type: 'world' })
    if (composition.parent !== 'world') {
      await runtime.profiles.writeDevice({ name: 'base', type: 'velocity', intrinsics: { frames: { torso: null },
        feedback: { pose_frame: null, velocity_frame: 'base', velocity_components: ['vx', 'vy', 'wz'], clock: 'simulation' } } })
      if (composition.parent !== 'base') await runtime.profiles.writeDevice({ name: composition.parent, type: 'joint',
        intrinsics: { frames: { [composition.frame]: null } }, extrinsics: { mount: { parent: 'base', parent_frame: 'base' } } })
    }
    for (const arm of composition.arms) await runtime.profiles.writeDevice({ name: arm, type: 'joint',
      intrinsics: { frames: { flange: null } }, extrinsics: { mount: { parent: composition.parent, parent_frame: composition.frame,
        translation_m: '???', rotation_xyzw: '???' } } })
    for (const [index, tool] of composition.tools.entries()) await runtime.profiles.writeDevice({ name: tool,
      type: tool.endsWith('hand') ? 'dexterous_hand' : 'gripper',
      extrinsics: { mount: { parent: composition.arms[index], parent_frame: 'flange' } } })
    const selected = composition.arms[0]
    await save([
      node('local-frame', { outputs: [fact(selected, '/intrinsics/frames/flange')] }),
      node('mount-survey', { inputs: [fact(selected, '/extrinsics/mount/translation_m')] }),
      node('world-geometry', { inputs: [fact('world', '/intrinsics/frames/fixture')] }),
    ], ['local-frame'])
    await done('local-frame')
    const view = await setup.plan.inspect()
    assert.equal(view.taskSatisfied, true)
    assert.deepEqual(view.next, [])
    assert.equal(view.nodes.find(node => node.id === 'mount-survey').relevance, 'deferred')
    const arm = (await runtime.devices.list()).find(device => device.name === selected)
    assert.equal(arm.extrinsics.mount.parent, composition.parent)
    assert.equal(arm.extrinsics.mount.parent_frame, composition.frame)
  }
})

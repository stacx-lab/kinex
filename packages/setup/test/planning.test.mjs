import {protocolDevice} from '../../core/test/fixtures/protocol.mjs'
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
  await writeFile(path.join(directory, '.kinex/devices/arm/profile.yaml'), 'name: arm\ntype: joint\nmodel:\n  format: urdf\n  path: missing.urdf\n  base_link: base\n  tip_link: tip\n')
  await setup.plan.save({ version: 1, nodes: [node('inspect', { inputs: [fact('arm', '/model/path')] })], task: null }, 0)
  assert.equal((await setup.plan.inspect()).next.length, 0)
  await assert.rejects(stat(path.join(directory, '.kinex/python')), { code: 'ENOENT' })
  assert.ok((await runtime.tools.list()).tools.some(tool => tool.name === 'device'))
})

test('only task targets and ancestors advance; no global calibration gate', async t => {
  const { runtime, setup, directory, save, evidence, done } = await fixture(t)
  await runtime.profiles.writeManifest({ identity: { id: 'robot', name: 'Robot', kind: 'arm' } })
  await protocolDevice(runtime, directory, 'sensor')
  await runtime.profiles.writeDevice({ description: '',
    name: 'camera',
    type: 'rgb',
    loaded: true,
    frames: { base: {parent: null, translation_m: null, rotation_xyzw: null} } })
  await runtime.profiles.writeDevice({ description: '',
    name: 'right_arm',
    type: 'joint',
    loaded: true,
    frames: { base: {parent: null, translation_m: null, rotation_xyzw: null} } })
  await evidence()
  await save([node('sensor-access', { outputs: [fact('sensor', '/runtime/nodes', [])] }),
    node('camera-geometry', { inputs: [fact('camera', '/color')] }),
    node('right-arm-model', { inputs: [fact('right_arm', '/model')] }),
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

test('inspection ignores content changes but missing facts and dependencies still invalidate affected branches', async t => {
  const { directory, runtime, setup, save, evidence, done } = await fixture(t)
  await runtime.profiles.writeDevice({ description: '',
    name: 'arm',
    type: 'joint',
    frames: { base: {parent: null, translation_m: null, rotation_xyzw: null}, tcp: { parent: "arm:base", translation_m: [0, 0, 0], rotation_xyzw: [0, 0, 0, 1] } } })
  await evidence()
  await save([node('tcp', { outputs: [fact('arm', '/frames/tcp')] }),
    node('reach', { dependsOn: ['tcp'] }), node('independent')], ['reach'])
  await assert.rejects(done('reach'), /prerequisites/)
  await done('tcp'); await done('reach'); await done('independent')
  assert.equal((await setup.plan.inspect()).taskSatisfied, true)
  await runtime.profiles.writeDevice({ description: '', name: 'arm', loaded: true })
  assert.equal((await setup.plan.inspect()).taskSatisfied, true)
  await runtime.profiles.writeDevice({ description: '',
    name: 'arm',
    frames: { tcp: { parent: "arm:base", translation_m: [0.1, 0, 0], rotation_xyzw: [0, 0, 0, 1] } } })
  assert.equal((await setup.plan.inspect()).taskSatisfied, true)
  await rm(path.join(directory, '.kinex/devices/arm/profile.yaml'))
  const states = Object.fromEntries((await setup.plan.inspect()).nodes.map(node => [node.id, node.status]))
  assert.deepEqual(states, { tcp: 'stale', reach: 'stale', independent: 'done' })
  await runtime.profiles.writeDevice({ description: '',
    name: 'arm',
    type: 'joint',
    frames: { base: {parent: null, translation_m: null, rotation_xyzw: null}, tcp: { parent: "arm:base", translation_m: [0.1, 0, 0], rotation_xyzw: [0, 0, 0, 1] } } })
  await done('tcp')
  assert.equal((await setup.plan.inspect()).nodes.find(node => node.id === 'reach').status, 'done')
  await setup.plan.select({ objective: 'Independent task', targets: ['independent'], facts: [] }, (await setup.plan.inspect()).revision)
  assert.equal((await setup.plan.inspect()).taskSatisfied, true)
  await evidence('source.txt', 'Changed evidence')
  assert.equal((await setup.plan.inspect()).taskSatisfied, true)
  await rm(path.join(directory, '.kinex/evidence/source.txt'))
  assert.equal((await setup.plan.inspect()).nodes.find(node => node.id === 'independent').status, 'stale')
})

test('inspection checks file presence and explicit profile values without comparing saved hashes', async t => {
  const { directory, runtime, setup, save, evidence, done } = await fixture(t)
  await runtime.profiles.writeDevice({ description: '',
    name: 'sensor',
    type: 'other',
    loaded: true,
    frames: { base: {parent: null, translation_m: null, rotation_xyzw: null} } })
  const file = await evidence()
  const input = await evidence('node.py', 'original input')
  const output = await evidence('output.txt', 'original output')
  const fileFact = path => ({ kind: 'file', path })
  const nodes = [node('check', { inputs: [fileFact(input), fact('sensor', '/loaded', true)], outputs: [fileFact(output)] })]
  await save(nodes, ['check'], [fileFact(input)])
  await done('check', file)
  await evidence('node.py', 'changed input')
  await evidence('output.txt', 'changed output')
  await save([{ ...nodes[0], title: 'Updated title' }], ['check'], [fileFact(input)])
  assert.equal((await setup.plan.inspect()).taskSatisfied, true)
  await runtime.profiles.writeDevice({ description: '', name: 'sensor', loaded: false })
  assert.equal((await setup.plan.inspect()).nodes[0].status, 'stale')
  await runtime.profiles.writeDevice({ description: '', name: 'sensor', loaded: true })
  await rm(path.join(directory, '.kinex', output))
  assert.equal((await setup.plan.inspect()).nodes[0].status, 'stale')
  await evidence('output.txt')
  await rm(path.join(directory, '.kinex', input))
  const view = await setup.plan.inspect()
  assert.equal(view.nodes[0].status, 'stale')
  assert.deepEqual(view.missing, [fileFact(input)])
  assert.equal(view.taskSatisfied, false)
})

test('partial TCP facts can satisfy a task while rotation and section request remain unknown', async t => {
  const { runtime, setup, save } = await fixture(t)
  await runtime.profiles.writeDevice({ description: '',
    name: 'tool',
    type: 'gripper',
    needs_calibration: 'orientation unknown',
    frames: { base: { parent: "arm:flange", translation_m: [0, 0, .1], rotation_xyzw: null } } })
  await save([], [], [fact('tool', '/frames/base/translation_m')])
  assert.equal((await setup.plan.inspect()).taskSatisfied, true)
  await setup.plan.select({ objective: 'Full pose', targets: [], facts: [fact('tool', '/frames/base/rotation_xyzw')] }, 1)
  assert.equal((await setup.plan.inspect()).taskSatisfied, false)
  assert.equal((await runtime.devices.list()).find(device => device.name === 'tool').needs_calibration, 'orientation unknown')
})

test('dual-arm prerequisites bind both particular TCPs, with producer dependencies', async t => {
  const { runtime, save, setup } = await fixture(t)
  for (const name of ['left', 'right']) await runtime.profiles.writeDevice({ description: '',
    name,
    type: 'joint',
    frames: { base: {parent: null, translation_m: null, rotation_xyzw: null} } })
  for (const [name, parent] of [['lt', 'left'], ['rt', 'right'], ['unrelated', 'left']])
    await runtime.profiles.writeDevice({ description: '',
      name,
      type: 'gripper',
      frames: { base: { parent: `${parent}:${'flange'}`, translation_m: null, rotation_xyzw: null, translation_m: name === 'rt' ? null : [0, 0, .1], rotation_xyzw: [0, 0, 0, 1] } } })
  const dual = node('dual', { kind: 'calibrate', skill: 'calibrate-dual-arm',
    bindings: { anchor: 'left', second: 'right', anchor_tcp: 'lt', second_tcp: 'rt' } })
  await save([dual], ['dual'])
  assert.equal((await setup.plan.inspect()).nodes[0].status, 'needs-input')
  await assert.rejects(save([{ ...dual, bindings: { ...dual.bindings, second_tcp: 'unrelated' } }], ['dual']), /attached to left/)
  await assert.rejects(save([dual, node('rt-translation', { outputs: [fact('rt', '/frames/base/translation_m')] })], ['dual']), /missing dependency/)
})

test('a usable base mode is not blocked by unknown facts it does not use', async t => {
  const { runtime, save, setup } = await fixture(t)
  const velocity = { description: '', transport: 'topic', direction: 'input', endpoint: '/kinex/base/velocity', type: 'kinex_interfaces/msg/TwistCommand' }
  await runtime.profiles.writeDevice({ description: '',
    name: 'base',
    type: 'locomotion',
    operations: { velocity },
    velocity: { units: 'si', axes: { vx: null } },
    modes: { drive: { description: 'Drives on velocity commands.', accepts: ['velocity'], transitions: [] } },
    stop: { behavior: 'halt', affected_devices: ['base'] },
    frames: { base: {parent: null, translation_m: null, rotation_xyzw: null} } })
  await save([node('drive-check', { kind: 'verify', skill: 'verify-base-motion', bindings: { base: 'base' },
    inputs: [fact('base', '/modes/drive')] })], ['drive-check'])
  assert.deepEqual((await setup.plan.inspect()).next, ['drive-check'])
  assert.equal((await runtime.devices.list())[0].posture, '???')
})

test('workspace skill override supplies the selected procedure and malformed deferred skills do not gate tasks', async t => {
  const { directory, runtime, setup, save } = await fixture(t)
  const dir = path.join(directory, '.kinex/skills/calibrate-tcp-offset')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'SKILL.md'), '---\nname: calibrate-tcp-offset\ndescription: Local procedure\n---\nUse local data.\n')
  await writeFile(path.join(dir, 'procedure.json'), JSON.stringify({ version: 1, roles: { probe: { types: ['other'] } }, quality: 'Local evidence' }))
  await runtime.profiles.writeDevice({ description: '',
    name: 'probe',
    type: 'other',
    frames: { base: {parent: null, translation_m: null, rotation_xyzw: null} } })
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
    await runtime.profiles.writeManifest({ identity: { id: composition.kind, name: composition.kind, kind: composition.kind } })
    await runtime.profiles.writeDevice({ description: '',
      name: 'world',
      type: 'world',
      frames: { base: {parent: null, translation_m: null, rotation_xyzw: null} } })
    if (composition.parent !== 'world') {
      await runtime.profiles.writeDevice({ description: '',
        name: 'base',
        type: 'locomotion',
        frames: { base: {parent: null, translation_m: null, rotation_xyzw: null}, torso: { parent: "base:base", translation_m: null, rotation_xyzw: null } } })
      if (composition.parent !== 'base') await runtime.profiles.writeDevice({ description: '',
        name: composition.parent,
        type: 'joint',
        frames: {
          [composition.frame]: { parent: `${composition.parent}:base`, translation_m: null, rotation_xyzw: null },
          base: { parent: "base:base", translation_m: null, rotation_xyzw: null,  }
} })
    }
    for (const arm of composition.arms) await runtime.profiles.writeDevice({ description: '',
      name: arm,
      type: 'joint',
      frames: {
        flange: { parent: `${arm}:base`, translation_m: null, rotation_xyzw: null },
        base: { parent: `${composition.parent}:${composition.frame}`, translation_m: null, rotation_xyzw: null }
} })
    for (const [index, tool] of composition.tools.entries()) await runtime.profiles.writeDevice({ description: '',
      name: tool,
      type: tool.endsWith('hand') ? 'joint' : 'gripper',
      frames: { base: { parent: `${composition.arms[index]}:${'flange'}`, translation_m: null, rotation_xyzw: null,  } } })
    const selected = composition.arms[0]
    await save([
      node('local-frame', { outputs: [fact(selected, '/frames/flange/parent')] }),
      node('mount-survey', { inputs: [fact(selected, '/frames/base/translation_m')] }),
      node('world-geometry', { inputs: [fact('world', '/frames/fixture')] }),
    ], ['local-frame'])
    await done('local-frame')
    const view = await setup.plan.inspect()
    assert.equal(view.taskSatisfied, true)
    assert.deepEqual(view.next, [])
    assert.equal(view.nodes.find(node => node.id === 'mount-survey').relevance, 'deferred')
    const arm = (await runtime.devices.list()).find(device => device.name === selected)
    assert.equal(arm.frames.base.parent, `${composition.parent}:${composition.frame}`)
  }
})

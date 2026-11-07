import { test } from 'node:test'
import { useUv } from '../../core/test/fixtures/python.mjs'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat, symlink } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import os from 'node:os'
import path from 'node:path'
import { createKinexRuntime } from '@kinex/core'
import { createKinexSetup, setupSkillRoots } from '../dist/index.js'
import { quality } from '../dist/calibration/compute.js'

const system = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim()

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kinex-compute-'))
  await useUv(path.join(directory, '.kinex'))
  const python = path.join(directory, '.kinex/python/.venv/bin/python3')
  await mkdir(path.dirname(python), { recursive: true })
  await symlink(system, python)
  const runtime = createKinexRuntime({ directory, builtinSkillRoots: setupSkillRoots, host: { ask: async () => {} } })
  const setup = createKinexSetup(runtime)
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  const json = async (name, value) => { const file = path.join(directory, name); await writeFile(file, JSON.stringify(value)); return file }
  const compute = async args => setup.tools.call('calib_compute', args, { sessionID: 'compute' })
  return { directory, python, runtime, setup, json, compute }
}

test('survey computes a known rigid mount, archives sources and never writes profiles', async t => {
  const { directory, runtime, compute, json } = await fixture(t)
  await runtime.profiles.writeDevice({ description: '',
    name: 'arm',
    type: 'joint',
    frames: { base: {parent: null, translation_m: null, rotation_xyzw: null} } })
  await runtime.profiles.writeDevice({ description: '',
    name: 'base',
    type: 'locomotion',
    frames: { base: {parent: null, translation_m: null, rotation_xyzw: null} } })
  const profile = path.join(directory, '.kinex/devices/arm/profile.yaml')
  const before = await readFile(profile, 'utf8')
  const points = [[0, 0, 0], [.1, 0, 0], [0, .1, 0], [0, 0, .1], [.2, .1, .3]]
  const source = await json('points.json', { arm_points_m: points,
    parent_points_m: points.map(([x, y, z]) => [.2 - y, .3 + x, .4 + z]) })
  const result = await compute({ operation: 'fit-mount', procedure: 'calibrate-fixed-arm-mount',
    bindings: { target: 'arm', parent: 'base' }, points: source, parent_frame: 'base' })
  assert.ok(!result.isError, result.output)
  const value = JSON.parse(result.output)
  assert.equal(value.quality, 'passed')
  const mount = value.proposedChanges[0].data.frames.base
  for (const [i, expected] of [.2, .3, .4].entries()) assert.ok(Math.abs(mount.translation_m[i] - expected) < 1e-8)
  assert.equal(mount.parent, 'base:base')
  assert.equal(await readFile(profile, 'utf8'), before)
  const artifacts = path.join(directory, '.kinex/calib', value.run, 'artifacts')
  const archived = JSON.parse(await readFile(path.join(artifacts, (await readdir(artifacts))[0]), 'utf8'))
  await json('points.json', { corrupted: true })
  assert.equal(archived.arm_points_m.length, 5)
  assert.ok(await readFile(path.join(directory, '.kinex', value.evidence), 'utf8'))
})

test('degenerate survey cannot propose a profile patch or complete a node', async t => {
  const { runtime, setup, compute, json } = await fixture(t)
  await runtime.profiles.writeDevice({ description: '',
    name: 'arm',
    type: 'joint',
    frames: { base: {parent: null, translation_m: null, rotation_xyzw: null} } })
  await runtime.profiles.writeDevice({ description: '',
    name: 'base',
    type: 'locomotion',
    frames: { base: {parent: null, translation_m: null, rotation_xyzw: null} } })
  await setup.plan.save({ version: 1, task: { objective: 'Mount', targets: ['mount'] }, nodes: [{ id: 'mount',
    title: 'Arm mount', kind: 'calibrate', skill: 'calibrate-fixed-arm-mount', bindings: { target: 'arm', parent: 'base' } }] }, 0)
  const points = [[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0]]
  const result = await compute({ operation: 'fit-mount', node: 'mount', parent_frame: 'base',
    points: await json('points.json', { arm_points_m: points, parent_points_m: points }) })
  const value = JSON.parse(result.output)
  assert.equal(result.isError, true)
  assert.equal(value.computation, 'succeeded', result.output)
  assert.equal(value.data.degenerate, true)
  assert.equal(value.quality, 'failed')
  assert.deepEqual(value.proposedChanges, [])
  await assert.rejects(setup.plan.record('mount', { status: 'done', note: 'Cannot accept', evidence: [value.evidence] }, 1), /Failed computation or quality/)
})

test('base checks require explicit tolerances, units, reference evidence and fresh timestamps', async t => {
  const { runtime, compute, json } = await fixture(t)
  await runtime.profiles.writeDevice({ description: '',
    name: 'base',
    type: 'locomotion',
    frames: { base: {parent: null, translation_m: null, rotation_xyzw: null} } })
  const input = { operation: 'verify-base', procedure: 'verify-base-interface', bindings: { base: 'base' } }
  const check = { name: 'vx', expected: .1, measured: .105, tolerance: .01, units: 'm/s', reference: 'tracked displacement / measured elapsed time', timestamps: [1, 2] }
  const file = await json('measurements.json', { required_checks: ['vx'], checks: [check] })
  const result = JSON.parse((await compute({ ...input, measurements: file })).output)
  assert.equal(result.quality, 'passed')
  assert.deepEqual(result.data.coverage, ['vx'])
  for (const bad of [{ ...check, tolerance: undefined }, { ...check, units: undefined },
    { ...check, reference: '' }, { ...check, timestamps: [1, 1] }, { ...check, measured: .2 }]) {
    await json('measurements.json', { required_checks: ['vx'], checks: [bad] })
    assert.equal(JSON.parse((await compute({ ...input, measurements: file })).output).quality, 'failed')
  }
  await json('measurements.json', { required_checks: ['vx', 'expiry'], checks: [check] })
  assert.equal(JSON.parse((await compute({ ...input, measurements: file })).output).quality, 'failed')
})

test('attempts reject changed participants and inputs and keep repeated computations', async t => {
  const { runtime, compute, json, directory } = await fixture(t)
  await runtime.profiles.writeDevice({ description: '',
    name: 'base',
    type: 'locomotion',
    frames: { base: {parent: null, translation_m: null, rotation_xyzw: null} } })
  const file = await json('measurements.json', { required_checks: ['units'], checks: [{ name: 'units', expected: 'normalized',
    measured: 'normalized', reference: 'SDK metadata' }] })
  const first = JSON.parse((await compute({ operation: 'verify-base', procedure: 'verify-base-interface', bindings: { base: 'base' },
    inputs: [{ kind: 'profile', device: 'base', pointer: '/type' }], measurements: file })).output)
  const second = JSON.parse((await compute({ operation: 'verify-base', run: first.run, measurements: file })).output)
  assert.notEqual(first.evidence, second.evidence)
  const wrong = await compute({ operation: 'verify-base', run: first.run, bindings: { base: 'other' }, measurements: file })
  assert.match(wrong.output, /immutable/)
  await writeFile(path.join(directory, '.kinex/devices/base/profile.yaml'), 'name: base\ntype: other\n')
  const stale = await compute({ operation: 'verify-base', run: first.run, measurements: file })
  assert.match(stale.output, /inputs changed/)
})

test('calibration computations never accept a caller-chosen interpreter', async t => {
  const { compute, json } = await fixture(t)
  const result = await compute({ operation: 'verify-base', procedure: 'verify-base-interface', bindings: { base: 'base' },
    measurements: await json('measurements.json', {}), interpreter: 'python3' })
  assert.equal(result.isError, true)
  assert.match(result.output, /interpreter/)
})

test('quality gates distinguish partial coverage and warnings without weakening minima', () => {
  assert.equal(quality('fit-tcp', { n: 4, residual_mm: 4 }), 'passed')
  assert.equal(quality('fit-tcp', { n: 4, residual_mm: 7 }), 'warning')
  assert.equal(quality('fit-tcp', { n: 3, residual_mm: 0 }), 'failed')
  assert.equal(quality('camera-intrinsics', { rms_px: .6, frames_used: 10, coverage_warnings: [] }), 'warning')
  assert.equal(quality('camera-intrinsics', { rms_px: .1, frames_used: 9, coverage_warnings: [] }), 'failed')
  assert.equal(quality('camera-extrinsics', { pairs_used: 5, residual_rot_deg: 1, residual_trans_mm: 4 }), 'passed')
  assert.equal(quality('camera-extrinsics', { pairs_used: 5, residual_rot_deg: 3, residual_trans_mm: 4 }), 'failed')
})

test('TCP solver produces translation only and preserves unresolved rotation', async t => {
  const { directory, runtime, compute, json } = await fixture(t)
  await mkdir(path.join(directory, '.kinex/devices/arm'), { recursive: true })
  await writeFile(path.join(directory, '.kinex/devices/arm/arm.urdf'), '<robot name="arm"><link name="base_link"/><link name="flange"/><joint name="j" type="revolute"><parent link="base_link"/><child link="flange"/><axis xyz="0 0 1"/><limit lower="-3" upper="3"/></joint></robot>')
  await runtime.profiles.writeDevice({ description: '',
    name: 'arm',
    type: 'joint',
    model: { format: 'urdf', path: 'arm.urdf', base_link: 'base_link', tip_link: 'flange' },
    frames: { base: {parent: null, translation_m: null, rotation_xyzw: null} } })
  await runtime.profiles.writeDevice({ description: '',
    name: 'tool',
    type: 'gripper',
    frames: {
      tcp: { parent: "tool:base", translation_m: '???', rotation_xyzw: [0, 0, 0, 1] },
      base: { parent: "arm:flange", translation_m: [0, 0, .02], rotation_xyzw: [0, 0, 1, 0] }
} })
  const s = Math.sqrt(.5)
  const quaternions = [[0, 0, 0, 1], [s, 0, 0, s], [0, s, 0, s], [0, 0, s, s], [-s, 0, 0, s], [0, -s, 0, s]]
  const samples = quaternions.map(([x, y, z, w]) => {
    const rotated = [2 * (x * z + w * y) * .12, 2 * (y * z - w * x) * .12, (1 - 2 * (x * x + y * y)) * .12]
    return { settled: true, kinematics: { frame: 'flange', pose: [.2 - rotated[0], .1 - rotated[1], .5 - rotated[2], x, y, z, w] } }
  })
  const result = await compute({ operation: 'fit-tcp', procedure: 'calibrate-tcp-offset', bindings: { arm: 'arm', target: 'tool' },
    samples: await json('samples.json', samples), frame: 'flange' })
  assert.ok(!result.isError, result.output)
  const value = JSON.parse(result.output)
  assert.equal(value.quality, 'passed')
  const patch = value.proposedChanges[0].data
  assert.ok(Math.abs(patch.frames.tcp.translation_m[2] - .10) < 1e-8)
  assert.equal(patch.extrinsics, undefined)
  assert.deepEqual(patch.frames.tcp.rotation_xyzw, [0, 0, 0, 1])
  await runtime.profiles.writeDevice({ name: 'tool', frames: { tcp: { rotation_xyzw: '???' } } })
  const unknownRotation = await compute({ operation: 'fit-tcp', procedure: 'calibrate-tcp-offset', bindings: { arm: 'arm', target: 'tool' },
    samples: await json('unknown-rotation.json', samples), frame: 'flange' })
  assert.ok(!unknownRotation.isError, unknownRotation.output)
  assert.equal(JSON.parse(unknownRotation.output).proposedChanges[0].data.frames.tcp.rotation_xyzw, '???')
  await runtime.profiles.writeDevice({ name: 'tool', frames: { base: { translation_m: '???' } } })
  const unknownMount = await compute({ operation: 'fit-tcp', procedure: 'calibrate-tcp-offset', bindings: { arm: 'arm', target: 'tool' },
    samples: await json('unknown-mount.json', samples), frame: 'flange' })
  assert.equal(unknownMount.isError, true)
  await runtime.profiles.writeDevice({ name: 'tool', frames: { base: { translation_m: [0, 0, .02] } } })
  await runtime.profiles.writeDevice(patch)
  assert.deepEqual((await runtime.devices.list()).find(device => device.name === 'tool').frames.base.translation_m, [0, 0, .02])
})

test('sensor bias adds the mean static residual and needs gravity for specific force', async t => {
  const { runtime, compute, json } = await fixture(t)
  const channel = (bias, extra = {}) => ({ axes: ['x', 'y', 'z'], bias, range: null, resolution: null, ...extra })
  await runtime.profiles.writeDevice({ description: '', name: 'imu', type: 'imu',
    measurement: { angular_velocity: channel({ x: .01, y: 0, z: 0 }), orientation: null, magnetic_field: null,
      linear_acceleration: channel({ x: 0, y: 0, z: 0 }, { quantity: 'specific_force' }) },
    frames: { base: { parent: null, translation_m: null, rotation_xyzw: null } } })
  const samples = await json('samples.json', Array.from({ length: 20 }, () => ({ device: 'imu',
    data: { angular_velocity: { x: .02, y: -.01, z: 0 }, linear_acceleration: { x: .1, y: 0, z: 9.9 } } })))
  const input = { operation: 'sensor-bias', procedure: 'calibrate-sensor-bias', bindings: { target: 'imu' }, samples }
  const missing = await compute(input)
  assert.equal(missing.isError, true)
  assert.match(missing.output, /gravity_m_s2/)
  const result = await compute({ ...input, gravity_m_s2: [0, 0, 9.80665] })
  assert.ok(!result.isError, result.output)
  const value = JSON.parse(result.output)
  assert.equal(value.quality, 'passed')
  const { measurement } = value.proposedChanges[0].data
  assert.ok(Math.abs(measurement.angular_velocity.bias.x - .03) < 1e-12)
  assert.ok(Math.abs(measurement.linear_acceleration.bias.z - (9.9 - 9.80665)) < 1e-12)
  await runtime.profiles.writeDevice(value.proposedChanges[0].data)
  const device = (await runtime.devices.list()).find(entry => entry.name === 'imu')
  assert.equal(device.measurement.linear_acceleration.quantity, 'specific_force')
  assert.ok(Math.abs(device.measurement.linear_acceleration.bias.x - .1) < 1e-12)
})

test('grip calibration introspects the bound gripper URDF', async t => {
  const { directory, runtime, compute } = await fixture(t)
  await mkdir(path.join(directory, '.kinex/devices/hand'), { recursive: true })
  await writeFile(path.join(directory, '.kinex/devices/hand/hand.urdf'), '<robot name="hand"><link name="base_link"/><link name="finger"/><joint name="finger_joint" type="prismatic"><parent link="base_link"/><child link="finger"/><axis xyz="1 0 0"/><limit lower="0" upper="0.04"/></joint></robot>')
  await runtime.profiles.writeDevice({ description: '', name: 'hand', type: 'gripper',
    model: { format: 'urdf', path: 'hand.urdf', base_link: 'base_link' },
    frames: { base: { parent: null, translation_m: null, rotation_xyzw: null } } })
  const result = await compute({ operation: 'urdf-introspect', procedure: 'calibrate-gripper-grip', bindings: { target: 'hand' } })
  assert.ok(!result.isError, result.output)
  assert.deepEqual(JSON.parse(result.output).data.model.joints.map(joint => [joint.name, joint.limits]), [['finger_joint', { min: 0, max: .04 }]])
})

test('cancelling an owned computation never publishes a result', async t => {
  const { runtime, setup, directory, python, json } = await fixture(t)
  await runtime.profiles.writeDevice({ description: '',
    name: 'base',
    type: 'locomotion',
    frames: { base: {parent: null, translation_m: null, rotation_xyzw: null} } })
  const marker = path.join(directory, 'started')
  await rm(python)
  await writeFile(python, `#!${system}\nimport time\nfrom pathlib import Path\nPath(${JSON.stringify(marker)}).write_text('started')\ntime.sleep(30)\n`, { mode: 0o755 })
  const abort = new AbortController()
  const pending = setup.tools.call('calib_compute', { operation: 'verify-base', procedure: 'verify-base-interface',
    bindings: { base: 'base' }, measurements: await json('measurements.json', {}) }, { sessionID: 'cancel', signal: abort.signal })
  for (let i = 0; i < 100; i++) {
    if (await stat(marker).then(() => true, () => false)) break
    await delay(20)
  }
  assert.ok(await stat(marker))
  abort.abort()
  assert.equal((await pending).isError, true)
  const runs = await readdir(path.join(directory, '.kinex/calib'))
  for (const run of runs) assert.ok(!(await readdir(path.join(directory, '.kinex/calib', run))).some(file => file.startsWith('result')))
})

test('stereo calibration solves one eye at a time and its proposals fit the profile', async t => {
  const { directory, runtime, compute } = await fixture(t)
  const base = { parent: null, translation_m: null, rotation_xyzw: null }
  await mkdir(path.join(directory, '.kinex/devices/arm'), { recursive: true })
  await writeFile(path.join(directory, '.kinex/devices/arm/arm.urdf'), '<robot name="arm"><link name="base_link"/><link name="flange"/><joint name="j" type="revolute"><parent link="base_link"/><child link="flange"/><axis xyz="0 0 1"/><limit lower="-1" upper="1" effort="1" velocity="1"/></joint></robot>')
  await runtime.profiles.writeDevice({ description: '', name: 'arm', type: 'joint',
    model: { format: 'urdf', path: 'arm.urdf', base_link: 'base_link', tip_link: 'flange' }, frames: { base } })
  await runtime.profiles.writeDevice({ description: '', name: 'mono', type: 'rgb', layout: 'mono', frames: { base } })
  const eyeFrame = parent => ({ parent, translation_m: '???', rotation_xyzw: '???' })
  await runtime.profiles.writeDevice({ description: '', name: 'pair', type: 'rgb', layout: 'stereo', left: '???', right: '???',
    frames: { base, left: eyeFrame('pair:base'), right: eyeFrame('pair:left') } })
  const evidence = path.join(directory, 'evidence')
  await mkdir(evidence)
  const env = { ...process.env, PYTHONPATH: new URL('../../core/assets/python', import.meta.url).pathname, PYTHONDONTWRITEBYTECODE: '1' }
  execFileSync(system, [new URL('./stereo_evidence.py', import.meta.url).pathname, evidence], { env })
  const images = Array.from({ length: 16 }, (_, index) => path.join(evidence, `${index}.png`))
  const intrinsics = target => ({ operation: 'camera-intrinsics', procedure: 'calibrate-camera-intrinsics', bindings: { target },
    images, square_mm: 30, model: 'opencv_fisheye' })
  assert.match((await compute(intrinsics('pair'))).output, /Select eye/)
  assert.match((await compute({ ...intrinsics('mono'), eye: 'left' })).output, /only supported for stereo/)

  assert.match((await compute({ ...intrinsics('pair'), eye: 'left', model: undefined })).output, /Choose model/)
  const solved = JSON.parse((await compute({ ...intrinsics('pair'), eye: 'left' })).output)
  assert.notEqual(solved.quality, 'failed', JSON.stringify(solved.data))
  assert.ok(solved.resolved.every(fact => fact.pointer.startsWith('/left/')))
  await runtime.profiles.writeDevice(solved.proposedChanges[0].data)

  // Reusing the sampling run supplies each eye's captures; the profile supplies a known lens model.
  const captures = images.map((file, index) => ({ index, device: 'pair', data: { left_file: file, right_file: file } }))
  await writeFile(path.join(directory, '.kinex/calib', solved.run, 'samples.json'), JSON.stringify([{ index: 99, device: 'arm', data: {} }, ...captures]))
  const reuse = { operation: 'camera-intrinsics', run: solved.run, square_mm: 30 }
  const left = JSON.parse((await compute({ ...reuse, eye: 'left' })).output)
  assert.equal(left.data.frames_used, solved.data.frames_used)
  assert.equal(left.data.distortion.model, 'opencv_fisheye')
  assert.match((await compute({ ...reuse, eye: 'right' })).output, /Choose model/)
  assert.ok(JSON.parse((await compute({ ...reuse, eye: 'right', model: 'opencv_fisheye' })).output).resolved.every(fact => fact.pointer.startsWith('/right/')))

  const extrinsics = { operation: 'camera-extrinsics', procedure: 'calibrate-camera-extrinsics', bindings: { target: 'pair', arm: 'arm' },
    samples: path.join(evidence, 'pairs.json'), mode: 'eye_in_hand', frame: 'flange' }
  assert.match((await compute(extrinsics)).output, /Select eye/)
  const mounted = JSON.parse((await compute({ ...extrinsics, eye: 'right' })).output)
  assert.equal(mounted.quality, 'passed', JSON.stringify(mounted.data))
  assert.ok(mounted.resolved.every(fact => /^\/frames\/(base|right)\//.test(fact.pointer)))
  await runtime.profiles.writeDevice(mounted.proposedChanges[0].data)

  const device = (await runtime.devices.list()).find(entry => entry.name === 'pair')
  assert.equal(device.left.distortion.model, 'opencv_fisheye')
  assert.equal(device.left.distortion.coefficients.length, 4)
  // The solved stream drives the node adapter, whose rays project back to their pixels.
  const roundTrip = 'import json, sys\nfrom kinex.lib.camera_geometry import OpenCVGeometry as G\ng = G(json.loads(sys.argv[1]), fisheye=True)\nprint(json.dumps(g.project(g.unproject([[400., 300.]]))))'
  const [[u, v]] = JSON.parse(execFileSync(system, ['-c', roundTrip, JSON.stringify(device.left)], { env, encoding: 'utf8' }))
  assert.ok(Math.abs(u - 400) < 1e-3 && Math.abs(v - 300) < 1e-3)
  assert.equal(device.right, '???')
  assert.equal(device.frames.base.parent, 'arm:flange')
  assert.deepEqual(device.frames.base.translation_m.map(value => Math.round(value * 1000)), [30, -60, 50])
  assert.deepEqual(device.frames.right, { parent: 'pair:base', translation_m: [0, 0, 0], rotation_xyzw: [0, 0, 0, 1] })
  assert.deepEqual(device.frames.left, eyeFrame('pair:right'))

  // The second eye is placed relative to the reference and leaves the measured base alone.
  const millimetres = values => values.map(value => Math.round(value * 1000) + 0)
  const second = JSON.parse((await compute({ ...extrinsics, eye: 'left' })).output)
  assert.deepEqual(Object.keys(second.proposedChanges[0].data.frames), ['left'])
  assert.equal(second.proposedChanges[0].data.frames.left.parent, 'pair:right')
  assert.deepEqual(millimetres(second.proposedChanges[0].data.frames.left.translation_m), [0, 0, 0])

  // A known eye-to-eye transform (here a factory baseline) places base from either eye.
  await runtime.profiles.writeDevice({ name: 'pair', frames: { left: { parent: 'pair:right', translation_m: [.06, 0, 0], rotation_xyzw: [0, 0, 0, 1] } } })
  const factory = JSON.parse((await compute({ ...extrinsics, eye: 'left' })).output).proposedChanges[0].data.frames
  assert.equal(factory.left, undefined)
  assert.equal(factory.base.parent, 'arm:flange')
  assert.deepEqual(millimetres(factory.base.translation_m), [-27, -78, 50])
})

test('board observations pair captures with settled poses and unproject through node geometry', () => {
  execFileSync(system, [new URL('./board_observations.py', import.meta.url).pathname],
    { env: { ...process.env, PYTHONPATH: new URL('../../core/assets/python', import.meta.url).pathname, PYTHONDONTWRITEBYTECODE: '1' } })
})

test('camera solver recovers fisheye and Brown-Conrady models and rejects fisheye folds', () => {
  execFileSync(system, [new URL('./camera_intrinsics.py', import.meta.url).pathname], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } })
})

test('joint stereo solve recovers the mount and eye-to-eye transform in both modes', async t => {
  const { directory, runtime, compute } = await fixture(t)
  const base = { parent: null, translation_m: null, rotation_xyzw: null }
  await mkdir(path.join(directory, '.kinex/devices/arm'), { recursive: true })
  await writeFile(path.join(directory, '.kinex/devices/arm/arm.urdf'), '<robot name="arm"><link name="base_link"/><link name="flange"/><joint name="j" type="revolute"><parent link="base_link"/><child link="flange"/><axis xyz="0 0 1"/><limit lower="-1" upper="1" effort="1" velocity="1"/></joint></robot>')
  await runtime.profiles.writeDevice({ description: '', name: 'arm', type: 'joint',
    model: { format: 'urdf', path: 'arm.urdf', base_link: 'base_link', tip_link: 'flange' }, frames: { base } })
  await runtime.profiles.writeDevice({ description: '', name: 'mono', type: 'rgb', layout: 'mono', frames: { base } })
  const unknown = parent => ({ parent, translation_m: '???', rotation_xyzw: '???' })
  await runtime.profiles.writeDevice({ description: '', name: 'pair', type: 'rgb', layout: 'stereo', left: '???', right: '???',
    frames: { base, left: unknown('pair:base'), right: unknown('pair:left') } })
  const evidence = path.join(directory, 'evidence')
  await mkdir(evidence)
  execFileSync(system, [new URL('./stereo_evidence.py', import.meta.url).pathname, evidence],
    { env: { ...process.env, PYTHONPATH: new URL('../../core/assets/python', import.meta.url).pathname, PYTHONDONTWRITEBYTECODE: '1' } })
  const millimetres = values => values.map(value => Math.round(value * 1000) + 0)
  const input = (name, mode, extra = {}) => ({ operation: 'camera-stereo-extrinsics', procedure: 'calibrate-camera-extrinsics',
    bindings: { target: 'pair', arm: 'arm' }, samples: path.join(evidence, `stereo_${name}.json`), mode, frame: 'flange', eye_to_eye: 'solve', ...extra })
  const run = async args => JSON.parse((await compute(args)).output)
  assert.match((await compute(input('in_hand', 'eye_in_hand', { bindings: { target: 'mono', arm: 'arm' } }))).output, /not a stereo rgb camera/)
  assert.match((await compute(input('in_hand', 'eye_in_hand', { bindings: { target: 'pair' } }))).output, /Bind arm/)

  for (const [name, mode, parent] of [['in_hand', 'eye_in_hand', 'arm:flange'], ['to_hand', 'eye_to_hand', 'arm:base']]) {
    const value = await run(input(name, mode))
    assert.equal(value.quality, 'passed', JSON.stringify(value.data))
    assert.equal(value.proposedChanges[0].data.frames.base.parent, parent)
    assert.deepEqual(millimetres(value.data.translation_m), [30, -60, 50])
    assert.deepEqual(millimetres(value.data.partner_translation_m), [60, 0, 0])
    assert.ok(Math.abs(value.data.baseline_m - .06) < 1e-3)
    await runtime.profiles.writeDevice(value.proposedChanges[0].data)
  }
  const device = (await runtime.devices.list()).find(entry => entry.name === 'pair')
  assert.deepEqual(device.frames.left, { parent: 'pair:base', translation_m: [0, 0, 0], rotation_xyzw: [0, 0, 0, 1] })
  assert.equal(device.frames.right.parent, 'pair:left')
  assert.deepEqual(millimetres(device.frames.right.translation_m), [60, 0, 0])
  assert.equal((await runtime.readiness()).items.find(item => item.id === 'profile:pair').detail.includes('frames.'), false)

  // keep holds the known eye-to-eye transform and solves only the mount.
  const kept = await run(input('in_hand', 'eye_in_hand', { eye_to_eye: 'keep' }))
  assert.equal(kept.quality, 'passed', JSON.stringify(kept.data))
  assert.deepEqual(millimetres(kept.data.translation_m), [30, -60, 50])
  assert.deepEqual(millimetres(kept.data.partner_translation_m), millimetres(device.frames.right.translation_m))
  assert.equal(kept.proposedChanges[0].data.frames.right, undefined)
  assert.match((await compute(input('in_hand', 'eye_in_hand', { eye_to_eye: 'keep', nominal_baseline_m: .06 }))).output, /only when solving/)

  // The profile's chain names the reference; with right as reference the transform inverts.
  await runtime.profiles.writeDevice({ name: 'pair', frames: { left: unknown('pair:right'), right: unknown('pair:base') } })
  const swapped = await run(input('in_hand', 'eye_in_hand', { nominal_baseline_m: .06 }))
  assert.ok(swapped.data.baseline_error_m < 1e-3)
  assert.equal(swapped.proposedChanges[0].data.frames.left.parent, 'pair:right')
  assert.equal(swapped.proposedChanges[0].data.frames.right.parent, 'pair:base')
  assert.ok(Math.abs(swapped.data.baseline_m - .06) < 1e-3)

  const biased = await run(input('biased', 'eye_in_hand'))
  assert.equal(biased.quality, 'failed', JSON.stringify(biased.data.residual_deg))
  assert.deepEqual(biased.proposedChanges, [])

  // Without a robot, paired views of a still board measure only the eye-to-eye transform.
  const eyes = name => ({ operation: 'camera-eye-to-eye', procedure: 'calibrate-camera-extrinsics', bindings: { target: 'pair' },
    samples: path.join(evidence, `stereo_${name}.json`), nominal_baseline_m: .06 })
  const measured = await run(eyes('to_hand'))
  assert.equal(measured.quality, 'passed', JSON.stringify(measured.data))
  assert.equal(measured.data.translation_m, undefined)
  assert.equal(measured.proposedChanges[0].data.method, 'stereo')
  assert.deepEqual(Object.keys(measured.proposedChanges[0].data.frames), ['left'])
  assert.equal(measured.proposedChanges[0].data.frames.left.parent, 'pair:right')
  assert.ok(Math.abs(measured.data.baseline_m - .06) < 1e-3)
  // A solved baseline that disagrees with the nominal one fails.
  assert.equal((await run({ ...eyes('to_hand'), nominal_baseline_m: .08 })).quality, 'failed')
})

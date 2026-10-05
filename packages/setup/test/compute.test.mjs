import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import os from 'node:os'
import path from 'node:path'
import { createKinexRuntime } from '@kinex/core'
import { createKinexSetup, setupSkillRoots } from '../dist/index.js'
import { quality } from '../dist/calibration/compute.js'

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kinex-compute-'))
  const runtime = createKinexRuntime({ directory, builtinSkillRoots: setupSkillRoots, host: { ask: async () => {} } })
  const setup = createKinexSetup(runtime)
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  const json = async (name, value) => { const file = path.join(directory, name); await writeFile(file, JSON.stringify(value)); return file }
  const compute = async args => setup.tools.call('calib_compute', { interpreter: 'python3', ...args }, { sessionID: 'compute' })
  return { directory, runtime, setup, json, compute }
}

test('survey computes a known rigid mount, archives sources and never writes profiles', async t => {
  const { directory, runtime, compute, json } = await fixture(t)
  await runtime.profiles.writeDevice({ name: 'arm', type: 'joint' })
  await runtime.profiles.writeDevice({ name: 'base', type: 'velocity' })
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
  const mount = value.proposedChanges[0].data.extrinsics.mount
  for (const [i, expected] of [.2, .3, .4].entries()) assert.ok(Math.abs(mount.translation_m[i] - expected) < 1e-8)
  assert.equal(mount.parent, 'base')
  assert.equal(await readFile(profile, 'utf8'), before)
  const artifacts = path.join(directory, '.kinex/calib', value.run, 'artifacts')
  const archived = JSON.parse(await readFile(path.join(artifacts, (await readdir(artifacts))[0]), 'utf8'))
  await json('points.json', { corrupted: true })
  assert.equal(archived.arm_points_m.length, 5)
  assert.ok(await readFile(path.join(directory, '.kinex', value.evidence), 'utf8'))
})

test('degenerate survey cannot propose a profile patch or complete a node', async t => {
  const { runtime, setup, compute, json } = await fixture(t)
  await runtime.profiles.writeDevice({ name: 'arm', type: 'joint' })
  await runtime.profiles.writeDevice({ name: 'base', type: 'velocity' })
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
  await runtime.profiles.writeDevice({ name: 'base', type: 'velocity' })
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
  await runtime.profiles.writeDevice({ name: 'base', type: 'velocity' })
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
  const { runtime, compute, json } = await fixture(t)
  await runtime.profiles.writeDevice({ name: 'arm', type: 'joint', intrinsics: { model: { format: 'joints', joints: [
    { name: 'j', type: 'revolute', limits: { min: -3, max: 3 }, max_velocity: null, max_effort: null },
  ] } } })
  await runtime.profiles.writeDevice({ name: 'tool', type: 'gripper', extrinsics: { mount: { parent: 'arm', parent_frame: 'flange' } } })
  const s = Math.sqrt(.5)
  const quaternions = [[0, 0, 0, 1], [s, 0, 0, s], [0, s, 0, s], [0, 0, s, s], [-s, 0, 0, s], [0, -s, 0, s]]
  const samples = quaternions.map(([x, y, z, w]) => {
    const rotated = [2 * (x * z + w * y) * .12, 2 * (y * z - w * x) * .12, (1 - 2 * (x * x + y * y)) * .12]
    return { settled: true, data: { frame_poses: { flange: [.2 - rotated[0], .1 - rotated[1], .5 - rotated[2], x, y, z, w] } } }
  })
  const result = await compute({ operation: 'fit-tcp', procedure: 'calibrate-tcp-offset', bindings: { arm: 'arm', target: 'tool' },
    samples: await json('samples.json', samples) })
  assert.ok(!result.isError, result.output)
  const value = JSON.parse(result.output)
  assert.equal(value.quality, 'passed')
  const patch = value.proposedChanges[0].data
  assert.ok(Math.abs(patch.extrinsics.mount.translation_m[2] - .12) < 1e-8)
  assert.equal(patch.extrinsics.mount.rotation_xyzw, undefined)
  await runtime.profiles.writeDevice(patch)
  assert.equal((await runtime.devices.list()).find(device => device.name === 'tool').extrinsics.mount.rotation_xyzw, '???')
})

test('cancelling an owned computation never publishes a result', async t => {
  const { runtime, setup, directory, json } = await fixture(t)
  await runtime.profiles.writeDevice({ name: 'base', type: 'velocity' })
  const interpreter = path.join(directory, 'slow-python')
  const marker = path.join(directory, 'started')
  await writeFile(interpreter, `#!/usr/bin/env python3\nimport time\nfrom pathlib import Path\nPath(${JSON.stringify(marker)}).write_text('started')\ntime.sleep(30)\n`, { mode: 0o755 })
  const abort = new AbortController()
  const pending = setup.tools.call('calib_compute', { operation: 'verify-base', procedure: 'verify-base-interface',
    bindings: { base: 'base' }, measurements: await json('measurements.json', {}), interpreter }, { sessionID: 'cancel', signal: abort.signal })
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

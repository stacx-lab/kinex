import { protocolDevice, inputOperation } from '../../core/test/fixtures/protocol.mjs'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, rm, symlink } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { createKinexRuntime, PermissionDeniedError } from '@kinex/core'
import { coreContribution, composeContributions } from '@kinex/core/integration'
import { createKinexSetup, setupContribution, setupSkillRoots, setupToolNames } from '../dist/index.js'

const globals = await mkdtemp(path.join(os.tmpdir(), 'kinex-setup-home-'))
process.env.KINEX_CONFIG_DIR = path.join(globals, 'config')
process.env.KINEX_DATA_DIR = path.join(globals, 'data')
after(() => rm(globals, { recursive: true, force: true }))
const allow = { ask: async () => {} }
async function fixture(t, host = allow) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kinex-setup-'))
  const runtime = createKinexRuntime({ directory, host, builtinSkillRoots: setupSkillRoots, reservedToolNames: setupToolNames })
  const setup = createKinexSetup(runtime)
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  return { directory, runtime, setup, capabilities: composeContributions([coreContribution(runtime), setupContribution(setup)]) }
}
async function seed(runtime) {
  await runtime.profiles.writeManifest({ identity: { id: 'test', name: 'Test', kind: 'arm' } })
  await runtime.profiles.writeDevice({ description: '',
    name: 'sensor',
    type: 'other',
    loaded: false,
    runtime: {nodes: []},
    frames: { base: {parent: null, translation_m: null, rotation_xyzw: null} } })
}
const call = { sessionID: 'setup' }

test('construction, catalogs and planning are inert and compose without duplicated skills', async t => {
  const { directory, runtime, setup, capabilities } = await fixture(t)
  const tools = await capabilities.tools.list()
  for (const name of setupToolNames) assert.ok(tools.tools.some(tool => tool.name === name))
  assert.deepEqual(tools.problems, [])
  assert.ok((await capabilities.skills.list()).some(skill => skill.name === 'setup-device'))
  assert.equal((await capabilities.skills.list()).filter(skill => skill.name === 'setup-device').length, 1)
  assert.ok((await runtime.devices.templates()).some(template => template.name === 'fastwam'))
  assert.equal((await setup.plan.inspect()).taskSatisfied, null)
  const context = await capabilities.context()
  assert.equal(context.sections['setup.plan'], undefined)
  assert.doesNotMatch((await runtime.context()).instructions, /setup_plan|\/onboarding/)
  assert.deepEqual(await readdir(directory), [])
  assert.deepEqual(capabilities.commands.filter(command => command.kind === 'workflow').map(command => command.name).sort(), ['calibrate', 'onboarding', 'register'])
  assert.ok(coreContribution(runtime).commands.some(command => command.name === 'unregister'))
  assert.deepEqual(setupContribution(setup).commands.map(command => command.name).sort(), ['calibrate', 'onboarding'])
  assert.deepEqual(setupToolNames, ['setup_plan', 'calib_sample', 'calib_compute'])
  assert.equal(tools.tools.filter(tool => tool.name === 'profile_write').length, 1)
  assert.ok(!tools.tools.some(tool => tool.name === 'calib_write'))
  assert.equal(context.sections['setup.guides'], undefined)
  assert.equal(context.sections['core.readiness'], undefined)
})

async function pythonSensor(runtime, directory, { fail = false, slowRead = false } = {}) {
  await seed(runtime)
  const marker = path.join(directory, 'unloading')
  await protocolDevice(runtime, directory, 'sensor', { loaded: true, handler: `import time
from pathlib import Path
def dispatch(action, args, owner, cancelled):
    if action == 'unload':
        Path(${JSON.stringify(marker)}).touch()
        time.sleep(.15)
        if ${fail ? 'True' : 'False'}: raise RuntimeError('failed release')
    if action in ('read', '$sample') and cancelled.wait(${slowRead ? 2 : 0}): raise InterruptedError('cancelled')
    return {'value': 1, 'ready': True}
` })
  return marker
}

test('sampling shares permissions, recording attribution and cancellation with core', async t => {
  const { runtime, setup, directory } = await fixture(t)
  await pythonSensor(runtime, directory)
  const events = []
  runtime.subscribe(event => events.push(event))
  const result = await setup.tools.call('calib_sample', { deviceID: 'sensor', procedure: 'setup-device', bindings: { target: 'sensor' } }, { ...call, callID: 'sample' })
  assert.ok(!result.isError, result.output)
  const run = result.output.match(/run: ([a-z0-9-]+)/)[1]
  assert.equal(JSON.parse(await readFile(path.join(directory, `.kinex/calib/${run}/samples.json`), 'utf8')).length, 1)
  assert.ok(events.some(event => event.type === 'execution' && event.event.callID === 'sample' && event.event.origin === 'agent'))
  await runtime.recording.stop()
  await runtime.dispose()
  assert.throws(() => setup.plan.inspect(), /disposed/)
})

test('disposing the borrowed runtime cancels an active setup sample', async t => {
  const { runtime, setup, directory } = await fixture(t)
  await pythonSensor(runtime, directory, { slowRead: true })
  const pending = setup.tools.call('calib_sample', { deviceID: 'sensor', procedure: 'setup-device', bindings: { target: 'sensor' } }, call)
  await delay(50)
  await runtime.dispose()
  assert.equal((await pending).isError, true)
  await assert.rejects(stat(path.join(directory, '.kinex/calib')), { code: 'ENOENT' })
})

test('URDF calibration borrows core model resolution and stores its result in setup', async t => {
  const { runtime, setup, directory } = await fixture(t)
  await seed(runtime)
  const python = await runtime.python.initialize()
  await mkdir(path.dirname(python.executable), { recursive: true })
  const executable = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim()
  await symlink(executable, python.executable)
  const arm = path.join(directory, '.kinex/devices/arm')
  await mkdir(arm, { recursive: true })
  await writeFile(path.join(arm, 'arm.urdf'), '<robot name="arm"><link name="base"/><link name="tip"/><joint name="j" type="revolute"><parent link="base"/><child link="tip"/><axis xyz="0 0 1"/><limit lower="-1" upper="1" effort="10" velocity="1"/></joint></robot>')
  await runtime.profiles.writeDevice({ description: '',
    name: 'arm',
    type: 'joint',
    loaded: true,
    runtime: {nodes: []},
    model: { format: 'urdf', path: 'arm.urdf', base_link: 'base', tip_link: 'tip' },
    frames: { base: {parent: null, translation_m: null, rotation_xyzw: null} } })
  const input = { operation: 'urdf-introspect', procedure: 'calibrate-joint-range', bindings: { arm: 'arm' } }
  await assert.rejects(setup.tools.call('calib_compute', input, { ...call,
    ask: async ({ permission }) => { throw new PermissionDeniedError(permission) },
  }), PermissionDeniedError)
  const result = await setup.tools.call('calib_compute', input, call)
  assert.ok(!result.isError, result.output)
  const response = JSON.parse(result.output)
  const saved = JSON.parse(await readFile(path.join(directory, '.kinex', response.evidence), 'utf8'))
  assert.equal(saved.computation, 'succeeded')
  assert.equal(saved.data.model.joints[0].name, 'j')
  await runtime.devices.unregister('arm')
  assert.ok(await stat(path.join(directory, '.kinex', response.evidence)))
})

test('onboarding and calibration share core profile writes and preserve planning purity', async t => {
  const { runtime, setup, directory, capabilities } = await fixture(t)
  await seed(runtime)
  const input = { kind: 'needed', data: { item: 'access:sensor', note: 'verify connection' } }
  const result = await capabilities.tools.call('profile_write', input, {
    directory, sessionID: 'onboarding', abort: new AbortController().signal,
    ask: async () => {}, questions: async () => ({}),
  })
  assert.ok(!result.isError, result.output)
  const file = path.join(directory, '.kinex/devices/sensor/profile.yaml')
  const before = await readFile(file, 'utf8')
  assert.equal((await runtime.readiness()).items.find(item => item.id === 'access:sensor').status, 'needs-calibration')
  assert.equal(await readFile(file, 'utf8'), before)
  assert.match((await setup.tools.call('calib_sample', { deviceID: 'sensor', procedure: 'setup-device', bindings: { target: 'sensor' } }, call)).output, /unloaded/i)
  for (const command of setupContribution(setup).commands) {
    const result = await command.execute('', { ...call, confirm: async () => false })
    assert.match(result.prompt, /profile_write/)
    assert.doesNotMatch(result.prompt, /calib_write/)
  }
})

test('calibration settles joint devices and computes URDF link poses from the captured sample', async t => {
  const { runtime, setup, directory } = await fixture(t)
  await seed(runtime)
  const python = await runtime.python.initialize()
  await mkdir(path.dirname(python.executable), { recursive: true })
  await symlink(execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim(), python.executable)
  const dir = path.join(directory, '.kinex/devices/arm')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'arm.urdf'), `<robot name="arm"><link name="base_link"/><link name="link"/><link name="flange"/>
<joint name="j" type="revolute"><parent link="base_link"/><child link="link"/><axis xyz="0 0 1"/><limit lower="-1" upper="1"/></joint>
<joint name="flange_joint" type="fixed"><parent link="link"/><child link="flange"/><origin xyz="1 0 0"/></joint></robot>`)
  await protocolDevice(runtime, directory, 'arm', { type: 'joint', home: null, stop: { behavior: 'hold', affected_devices: ['arm'] },
    model: { format: 'urdf', path: 'arm.urdf', base_link: 'base_link', tip_link: 'flange' }, handler: `stamp = 0
def dispatch(action, args, owner, cancelled):
    global stamp
    if action == '$sample':
        if not args.get('cached'): stamp += 1
        return {'positions': [.35], 'velocities': [0], 'joint_names': ['j'], 'timestamp': stamp}
    return {'ok': True}
` })
  await (await runtime.devices.load('arm')).ready
  const input = { deviceID: 'arm', procedure: 'setup-device', bindings: { target: 'arm' } }
  for (const frame of [undefined, 'flange']) {
    for (const cached of [false, true]) {
      const result = await setup.tools.call('calib_sample', { ...input, frame, args: { cached },
        settle: { stable_reads: 2, timeout_s: cached ? .1 : 2 } }, call)
      assert.ok(!result.isError, result.output)
      const run = result.output.match(/run: ([a-z0-9-]+)/)[1]
      const [sample] = JSON.parse(await readFile(path.join(directory, `.kinex/calib/${run}/samples.json`), 'utf8'))
      assert.equal(sample.settled, !cached)
      assert.equal(sample.kinematics?.frame, frame)
      if (!frame) continue
      const expected = [Math.cos(.35), Math.sin(.35), 0, 0, 0, Math.sin(.175), Math.cos(.175)]
      sample.kinematics.pose.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-9, String(sample.kinematics.pose)))
    }
  }
  assert.match((await setup.tools.call('calib_sample', { ...input, frame: 'missing' }, call)).output, /must name a URDF link of joint device arm/)
})

test('calibration archives both RGBD files and never appends an incomplete sample', async t => {
  const { runtime, setup, directory } = await fixture(t)
  await seed(runtime)
  await runtime.profiles.writeDevice({ description: '',
    name: 'camera',
    type: 'rgbd',
    loaded: false,
    runtime: {nodes: []},
    color: { width: 1, height: 1 },
    depth: { width: 1, height: 1,
      registration: 'color', quantity: 'z', scale_m_per_unit: .001, invalid_value: 0,
      valid_range_m: { min: .001, max: 65.535 } },
    frames: { base: {parent: null, translation_m: null, rotation_xyzw: null} } })
  const output = path.join(directory, '.kinex/devices/camera/out')
  await mkdir(output, { recursive: true })
  await writeFile(path.join(output, 'color.png'), 'color evidence')
  await writeFile(path.join(output, 'depth.pgm'), 'depth evidence')
  await protocolDevice(runtime, directory, 'camera', { ...(await runtime.devices.list()).find(d=>d.name==='camera'), operations: {capture: inputOperation('capture')}, handler: `def dispatch(action, args, owner, cancelled):
    if action == '$sample':
        return {'file': ${JSON.stringify(path.join(output, 'color.png'))}, 'depth_file': ${JSON.stringify(path.join(output, 'depth.pgm'))}, 'timestamp': 1}
    return {'ok': True}
` })
  await (await runtime.devices.load('camera')).ready
  const input = { deviceID: 'camera', procedure: 'setup-device', bindings: { target: 'camera' } }
  const result = await setup.tools.call('calib_sample', input, call)
  assert.ok(!result.isError, result.output)
  const run = result.output.match(/run: ([a-z0-9-]+)/)[1]
  const samplesPath = path.join(directory, `.kinex/calib/${run}/samples.json`)
  const [sample] = JSON.parse(await readFile(samplesPath, 'utf8'))
  for (const file of [sample.file, sample.data.depth_file])
    assert.equal(path.dirname(file), path.join(directory, `.kinex/calib/${run}/artifacts`))
  await rm(path.join(output, 'depth.pgm'))
  const failed = await setup.tools.call('calib_sample', { deviceID: 'camera', run }, call)
  assert.equal(failed.isError, true)
  assert.equal(JSON.parse(await readFile(samplesPath, 'utf8')).length, 1)
  await rm(output, { recursive: true })
  assert.equal(await readFile(sample.file, 'utf8'), 'color evidence')
  assert.equal(await readFile(sample.data.depth_file, 'utf8'), 'depth evidence')
})

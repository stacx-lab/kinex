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
  await runtime.profiles.writeManifest({ identity: { id: 'test', name: 'Test', kind: 'arm', platform: 'real' } })
  await runtime.profiles.writeDevice({ name: 'sensor', type: 'other', loaded: false, access: { connection: { kind: 'mock' } } })
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
  assert.equal(typeof context.sections['setup.guides'], 'string')
  const roots = JSON.parse(context.sections['setup.provisioning'])
  assert.match(roots.core_library, /core.*assets[/\\]python$/)
  assert.match(roots.setup_library, /setup.*assets[/\\]python$/)
  assert.equal(context.sections['core.readiness'], undefined)
})

test('setup skill discovery preserves metadata with Windows line endings', async t => {
  const { directory, capabilities } = await fixture(t)
  const source = await readFile(new URL('../assets/builtin/skill/onboard-ros2/SKILL.md', import.meta.url), 'utf8')
  const target = path.join(directory, '.kinex/skill/onboard-ros2')
  await mkdir(target, { recursive: true })
  const file = path.join(target, 'SKILL.md')
  await writeFile(file, source.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n'))
  const skill = (await capabilities.skills.list()).find(skill => skill.name === 'onboard-ros2')
  assert.equal(skill.file, file)
  assert.match(skill.description, /ROS 2 hardware/)
})

async function pythonSensor(runtime, directory, { fail = false, slowRead = false } = {}) {
  await seed(runtime)
  await runtime.profiles.writeDevice({ name: 'sensor', access: { connection: { kind: 'process' }, driver: {
    interpreter: 'python3', actions: ['load', 'unload', 'status', 'read'], timeout_s: 5,
  } } })
  const marker = path.join(directory, 'unloading')
  await writeFile(path.join(directory, '.kinex/devices/sensor/driver.py'), `import time\nfrom kinex.driver_protocol import run\ndef dispatch(action, args):\n    if action == 'unload':\n        open(${JSON.stringify(marker)}, 'w').close()\n        time.sleep(.15)\n        return {'ok': ${fail ? 'False' : 'True'}, 'error': 'failed release'}\n    if action == 'read': time.sleep(${slowRead ? 2 : 0})\n    return {'ok': True, 'value': 1}\nrun(dispatch, lambda: None)\n`)
  await (await runtime.devices.load('sensor')).ready
  return marker
}

test('sampling shares permissions, recording attribution and cancellation with core', async t => {
  const { runtime, setup, directory } = await fixture(t)
  await pythonSensor(runtime, directory)
  const events = []
  runtime.subscribe(event => events.push(event))
  await runtime.recording.start({ sessionID: 'setup', specs: { sensor: { rate: 1 } } })
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
  await runtime.profiles.writeDevice({ name: 'arm', type: 'joint', loaded: true,
    access: { connection: { kind: 'mock' } },
    intrinsics: { model: { format: 'urdf', path: 'arm.urdf', base_link: 'base', tip_link: 'tip' } },
  })
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

test('calibration requests FK at the captured joint sample and stores poses separately', async t => {
  const { runtime, setup, directory } = await fixture(t)
  await seed(runtime)
  await runtime.profiles.writeDevice({ name: 'arm', type: 'joint', loaded: false,
    access: { connection: { kind: 'tcp', host: 'localhost', port: 1 }, driver: {
      interpreter: 'python3', actions: ['load', 'unload', 'status', 'read', 'fk', 'write', 'stop'],
    } }, intrinsics: {
      model: { format: 'joints', joints: [{ name: 'j', type: 'revolute', limits: { min: -1, max: 1 }, max_velocity: null, max_effort: null }] },
      frames: {},
      kinematics: { frame: 'flange', fk: 'driver', ik: null, frame_to_reported: [0, 0, 0, 0, 0, 0, 1] },
      home: null, control: { mode: 'position' }, feedback: { velocities: false, efforts: false },
      stop: { behavior: 'hold', affected_devices: ['arm'] },
    } })
  await writeFile(path.join(directory, '.kinex/devices/arm/driver.py'), `from kinex.driver_protocol import run

def dispatch(action, args):
    if action == 'read':
        return {'ok': True, 'positions': [.35], 'velocities': [], 'efforts': [], 'faults': [], 'timestamp': 7}
    if action == 'fk':
        assert args == {'joints': [.35], 'frame': 'flange', 'reference_frame': None}
        return {'ok': True, 'pose': [.35, 0, 0, 0, 0, 0, 1], 'frame': 'flange', 'reference_frame': None}
    return {'ok': True}
run(dispatch, lambda: None)
`)
  await (await runtime.devices.load('arm')).ready
  const result = await setup.tools.call('calib_sample', { deviceID: 'arm', frame: 'flange', procedure: 'setup-device', bindings: { target: 'arm' } }, call)
  assert.ok(!result.isError, result.output)
  const run = result.output.match(/run: ([a-z0-9-]+)/)[1]
  const [sample] = JSON.parse(await readFile(path.join(directory, `.kinex/calib/${run}/samples.json`), 'utf8'))
  assert.equal(sample.data.frame_poses, undefined)
  assert.equal(sample.data.timestamp, 7)
  assert.deepEqual(sample.kinematics, { pose: [.35, 0, 0, 0, 0, 0, 1], frame: 'flange', reference_frame: null })
})

test('calibration settles hands on fresh feedback and computes FK after settle timeout', async t => {
  const { runtime, setup, directory } = await fixture(t)
  await seed(runtime)
  await runtime.profiles.writeDevice({ name: 'hand', type: 'dexterous_hand', loaded: false,
    access: { connection: { kind: 'mock' }, driver: {
      interpreter: 'python3', actions: ['load', 'unload', 'status', 'read', 'fk', 'write', 'stop'],
    } }, intrinsics: {
      model: { format: 'joints', joints: [{ name: 'j', type: 'revolute', limits: { min: -1, max: 1 }, max_velocity: null, max_effort: null }] },
      frames: {}, kinematics: { frame: 'tip', fk: 'driver', ik: null, frame_to_reported: [0, 0, 0, 0, 0, 0, 1] },
      home: null, control: { mode: 'position' }, feedback: { velocities: true, efforts: false },
      stop: { behavior: 'hold', affected_devices: ['hand'] },
    } })
  await writeFile(path.join(directory, '.kinex/devices/hand/driver.py'), `from kinex.driver_protocol import run
stamp = 0
def dispatch(action, args):
    global stamp
    if action == 'read':
        if not args.get('cached'): stamp += 1
        return {'ok': True, 'positions': [.35], 'velocities': [0], 'efforts': [], 'faults': [], 'timestamp': stamp}
    if action == 'fk':
        assert args['joints'] == [.35]
        return {'ok': True, 'pose': [.35, 0, 0, 0, 0, 0, 1], 'frame': 'tip', 'reference_frame': None}
    return {'ok': True}
run(dispatch, lambda: None)
`)
  await (await runtime.devices.load('hand')).ready
  const input = { deviceID: 'hand', procedure: 'setup-device', bindings: { target: 'hand' } }
  for (const frame of [undefined, 'tip']) {
    for (const cached of [false, true]) {
      const result = await setup.tools.call('calib_sample', { ...input, frame, args: { cached },
        settle: { stable_reads: 2, timeout_s: cached ? .1 : 2 } }, call)
      assert.ok(!result.isError, result.output)
      const run = result.output.match(/run: ([a-z0-9-]+)/)[1]
      const [sample] = JSON.parse(await readFile(path.join(directory, `.kinex/calib/${run}/samples.json`), 'utf8'))
      assert.equal(sample.settled, !cached)
      assert.equal(sample.kinematics?.frame, frame)
    }
  }
})

test('calibration archives both RGBD files and never appends an incomplete sample', async t => {
  const { runtime, setup, directory } = await fixture(t)
  await seed(runtime)
  await runtime.profiles.writeDevice({ name: 'camera', type: 'rgbd', loaded: false,
    access: { connection: { kind: 'mock' }, driver: {
      interpreter: 'python3', actions: ['load', 'unload', 'status', 'read'],
    } }, intrinsics: {
      color: { width: 1, height: 1, pixel_format: 'rgb8', image_format: 'png' },
      depth: { width: 1, height: 1, pixel_format: 'uint16', image_format: 'pgm16_be',
        registration: 'color', quantity: 'z', scale_m_per_unit: .001, invalid_value: 0,
        valid_range_m: { min: .001, max: 65.535 } },
    } })
  const output = path.join(directory, '.kinex/devices/camera/out')
  await mkdir(output, { recursive: true })
  await writeFile(path.join(output, 'color.png'), 'color evidence')
  await writeFile(path.join(output, 'depth.pgm'), 'depth evidence')
  await writeFile(path.join(directory, '.kinex/devices/camera/driver.py'), `from kinex.driver_protocol import run
def dispatch(action, args):
    if action == 'read':
        return {'ok': True, 'file': ${JSON.stringify(path.join(output, 'color.png'))}, 'depth_file': ${JSON.stringify(path.join(output, 'depth.pgm'))}, 'timestamp': 1}
    return {'ok': True}
run(dispatch, lambda: None)
`)
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

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
  assert.equal(JSON.parse(context.sections['setup.plan']).task, null)
  assert.doesNotMatch((await runtime.context()).instructions, /setup_plan|\/onboarding/)
  assert.deepEqual(await readdir(directory), [])
  assert.deepEqual(capabilities.commands.filter(command => command.kind === 'workflow').map(command => command.name).sort(), ['calibrate', 'onboarding', 'register'])
  assert.ok(coreContribution(runtime).commands.some(command => command.name === 'unregister'))
  assert.deepEqual(setupContribution(setup).commands.map(command => command.name).sort(), ['calibrate', 'onboarding'])
  assert.deepEqual(setupToolNames, ['setup_plan', 'calib_sample', 'calib_compute'])
  assert.equal(tools.tools.filter(tool => tool.name === 'profile_write').length, 1)
  assert.ok(!tools.tools.some(tool => tool.name === 'calib_write'))
  assert.equal(context.sections['setup.guides'], undefined)
  assert.match(context.sections['core.readiness'], /identity:/)
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

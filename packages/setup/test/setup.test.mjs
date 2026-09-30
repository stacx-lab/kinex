import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, rm, symlink } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { createKinexRuntime, PermissionDeniedError, kinexPermissionAction } from '@kinex/core'
import { coreContribution, composeContributions } from '@kinex/core/integration'
import { createKinexSetup, setupContribution, setupSkillRoots, setupToolNames, setupPermissionDefaults } from '../dist/index.js'

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
  assert.ok((await setup.devices.templates()).some(template => template.name === 'fastwam'))
  assert.ok((await setup.calibration.plan()).items.some(item => item.id === 'identity'))
  const context = await capabilities.context()
  assert.match(context.sections['setup.calibration'], /onboarding/)
  assert.doesNotMatch((await runtime.context()).instructions, /calib_write|\/onboarding|setup-device/)
  assert.deepEqual(await readdir(directory), [])
  assert.deepEqual(capabilities.commands.filter(command => command.kind === 'workflow').map(command => command.name).sort(), ['calibrate', 'onboarding', 'register'])
  assert.ok(!coreContribution(runtime).commands.some(command => command.name === 'unregister'))
})

test('setup tools preserve profile validation, loaded intent and explicit calibration clears', async t => {
  const { runtime, setup, directory } = await fixture(t)
  await seed(runtime)
  const write = data => setup.tools.call('calib_write', data, call)
  assert.equal((await write({ kind: 'device', data: { name: 'sensor', loaded: true } })).isError, true)
  assert.ok(!(await write({ kind: 'needed', data: { item: 'access:sensor', note: 'verify connection' } })).isError)
  assert.equal((await runtime.readiness()).items.find(item => item.id === 'access:sensor').status, 'needs-calibration')
  await assert.rejects(runtime.profiles.writeDevice({ name: 'sensor', access: { connection: '???', needs_calibration: null } }), /cannot clear/)
  await runtime.profiles.writeDevice({ name: 'sensor', access: { needs_calibration: null } })
  assert.equal((await runtime.readiness()).items.find(item => item.id === 'access:sensor').status, 'done')
  const before = await readFile(path.join(directory, '.kinex/devices/sensor/profile.yaml'), 'utf8')
  await setup.calibration.plan()
  assert.equal(await readFile(path.join(directory, '.kinex/devices/sensor/profile.yaml'), 'utf8'), before)
  assert.match((await setup.tools.call('calib_sample', { deviceID: 'sensor', routine: 'test' }, call)).output, /unloaded/i)
})

test('invocation permissions take precedence and setup defaults preserve configured denial', async t => {
  const { runtime, setup, capabilities, directory } = await fixture(t)
  await seed(runtime)
  await assert.rejects(capabilities.tools.call('calib_write', { kind: 'device', data: { name: 'sensor' } }, {
    directory, sessionID: 'denied', abort: new AbortController().signal,
    ask: async permission => { throw new PermissionDeniedError(permission.permission) }, questions: async () => ({}),
  }), PermissionDeniedError)
  assert.equal(kinexPermissionAction('calib_write', {}, setupPermissionDefaults), 'allow')
  assert.equal(kinexPermissionAction('calib_write', { calib_write: 'deny' }, setupPermissionDefaults), 'deny')
  const closed = new AbortController()
  closed.abort()
  await assert.rejects(setup.tools.call('calib_write', { kind: 'device', data: { name: 'sensor' } }, { ...call, signal: closed.signal }))
  const noHost = createKinexRuntime({ directory })
  t.after(() => noHost.dispose())
  await assert.rejects(createKinexSetup(noHost).tools.call('calib_write', { kind: 'device', data: { name: 'sensor' } }, call), PermissionDeniedError)
})

test('skill overrides refresh, retain prerequisites and never create a nearer workspace', async t => {
  const { runtime, directory, capabilities } = await fixture(t)
  await seed(runtime)
  const skill = path.join(directory, '.kinex/skill/setup-device')
  await mkdir(skill, { recursive: true })
  await writeFile(path.join(skill, 'SKILL.md'), '---\nname: setup-device\ndescription: local\nrequires: access:missing\n---\nlocal procedure')
  assert.equal((await capabilities.skills.load('setup-device')).content, 'local procedure')
  assert.match((await runtime.tools.call('skill', { name: 'setup-device' }, call)).output, /WARNING/)
  await writeFile(path.join(skill, 'SKILL.md'), '---\nname: setup-device\ndescription: changed\n---\nupdated procedure')
  assert.equal((await capabilities.skills.load('setup-device')).content, 'updated procedure')
  await mkdir(path.join(directory, '.kinex/tool'), { recursive: true })
  await writeFile(path.join(directory, '.kinex/tool/calib_write.js'), 'export default {description:"collision", execute: async () => ({title:"bad", output:"bad"})}')
  assert.ok((await capabilities.tools.list()).problems.some(problem => problem.includes('calib_write')))
  const child = path.join(directory, 'nested')
  await mkdir(child)
  const nested = createKinexRuntime({ directory: child, builtinSkillRoots: setupSkillRoots })
  t.after(() => nested.dispose())
  assert.equal((await nested.skills.load('setup-device')).content, 'updated procedure')
  await createKinexSetup(nested).context()
  assert.deepEqual(await readdir(child), [])
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

async function waitFor(file) {
  for (let attempt = 0; attempt < 200; attempt++) {
    try { await stat(file); return } catch (error) { if (error.code !== 'ENOENT') throw error }
    await delay(10)
  }
  throw new Error(`timed out waiting for ${file}`)
}

test('unregister confirms, finalizes capture and fences queued load until deletion', async t => {
  const { runtime, setup, directory } = await fixture(t)
  const marker = await pythonSensor(runtime, directory)
  const command = setupContribution(setup).commands.find(command => command.name === 'unregister')
  assert.match((await command.execute('sensor', { ...call, confirm: async () => false })).text, /Cancelled/)
  assert.equal((await runtime.devices.list()).length, 1)
  await runtime.recording.start({ sessionID: 'setup', specs: { sensor: { rate: 10 } } })
  const removed = command.execute('sensor', { ...call, confirm: async () => true })
  await waitFor(marker)
  const load = assert.rejects(runtime.devices.load('sensor'), /unknown device/)
  await removed
  await load
  await assert.rejects(stat(path.join(directory, '.kinex/devices/sensor')), { code: 'ENOENT' })
  await runtime.recording.stop()
})

test('failed deactivation keeps the registered profile and driver', async t => {
  const { runtime, setup, directory } = await fixture(t)
  await pythonSensor(runtime, directory, { fail: true })
  await assert.rejects(setup.devices.unregister('sensor'), /unload failed/)
  assert.equal((await runtime.devices.list()).length, 1)
  await stat(path.join(directory, '.kinex/devices/sensor/driver.py'))
})

test('sampling shares permissions, recording attribution and cancellation with core', async t => {
  const { runtime, setup, directory } = await fixture(t)
  await pythonSensor(runtime, directory)
  const events = []
  runtime.subscribe(event => events.push(event))
  await runtime.recording.start({ sessionID: 'setup', specs: { sensor: { rate: 1 } } })
  const result = await setup.tools.call('calib_sample', { deviceID: 'sensor', routine: 'measured' }, { ...call, callID: 'sample' })
  assert.ok(!result.isError, result.output)
  assert.equal(JSON.parse(await readFile(path.join(directory, '.kinex/calib/measured/samples.json'), 'utf8')).length, 1)
  assert.ok(events.some(event => event.type === 'execution' && event.event.callID === 'sample' && event.event.origin === 'agent'))
  await runtime.recording.stop()
  await runtime.dispose()
  assert.throws(() => setup.calibration.plan(), /disposed/)
})

test('disposing the borrowed runtime cancels an active setup sample', async t => {
  const { runtime, setup, directory } = await fixture(t)
  await pythonSensor(runtime, directory, { slowRead: true })
  const pending = setup.tools.call('calib_sample', { deviceID: 'sensor', routine: 'cancelled' }, call)
  await delay(50)
  await runtime.dispose()
  assert.equal((await pending).isError, true)
  await assert.rejects(stat(path.join(directory, '.kinex/calib/cancelled/samples.json')), { code: 'ENOENT' })
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
  const input = { routine: 'urdf-introspect', deviceID: 'arm' }
  await assert.rejects(setup.tools.call('device_calibrate', input, { ...call,
    ask: async ({ permission }) => { throw new PermissionDeniedError(permission) },
  }), PermissionDeniedError)
  const result = await setup.tools.call('device_calibrate', input, call)
  assert.ok(!result.isError, result.output)
  const saved = JSON.parse(await readFile(path.join(directory, '.kinex/calib/urdf-introspect-arm.json'), 'utf8'))
  assert.equal(saved.status, 'ok')
  assert.equal(saved.data.joints[0].name, 'j')
  await setup.devices.unregister('arm')
  await assert.rejects(stat(path.join(directory, '.kinex/calib/urdf-introspect-arm.json')), { code: 'ENOENT' })
})

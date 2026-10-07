import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { createKinexRuntime, PermissionDeniedError, kinexPermissionAction } from '../dist/index.js'
import { coreContribution } from '../dist/integration.js'

const globals = await mkdtemp(path.join(os.tmpdir(), 'kinex-management-home-'))
process.env.KINEX_CONFIG_DIR = path.join(globals, 'config')
process.env.KINEX_DATA_DIR = path.join(globals, 'data')
after(() => rm(globals, { recursive: true, force: true }))
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kinex-management-'))
  const runtime = createKinexRuntime({ directory, host: { ask: async () => {} } })
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  return { directory, runtime, capabilities: coreContribution(runtime) }
}
async function seed(runtime) {
  await runtime.profiles.writeManifest({ identity: { id: 'test', name: 'Test', kind: 'arm', platform: 'real' } })
  await runtime.profiles.writeDevice({ name: 'sensor', type: 'other', loaded: false, access: { connection: { kind: 'mock' } } })
}
const call = { sessionID: 'core' }

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

test('core profile writes preserve validation, loaded intent and explicit calibration clears', async t => {
  const { runtime, directory } = await fixture(t)
  await seed(runtime)
  const write = data => runtime.tools.call('profile_write', data, call)
  assert.equal((await write({ kind: 'device', data: { name: 'sensor', loaded: true } })).isError, true)
  assert.ok(!(await write({ kind: 'needed', data: { item: 'access:sensor', note: 'verify connection' } })).isError)
  assert.equal((await runtime.readiness()).items.find(item => item.id === 'access:sensor').status, 'needs-calibration')
  await assert.rejects(runtime.profiles.writeDevice({ name: 'sensor', access: { connection: '???', needs_calibration: null } }), /cannot clear/)
  await runtime.profiles.writeDevice({ name: 'sensor', access: { needs_calibration: null } })
  assert.equal((await runtime.readiness()).items.find(item => item.id === 'access:sensor').status, 'done')
  const before = await readFile(path.join(directory, '.kinex/devices/sensor/profile.yaml'), 'utf8')
  const invalid = await write({ kind: 'device', data: { name: 'sensor', access: { connection: { kind: 'invalid' } } } })
  assert.equal(invalid.isError, true)
  await runtime.readiness()
  assert.equal(await readFile(path.join(directory, '.kinex/devices/sensor/profile.yaml'), 'utf8'), before)
  await (await runtime.devices.load('sensor')).ready
  assert.ok(!(await write({ kind: 'device', data: { name: 'sensor', access: { source: 'user' } } })).isError)
  assert.equal((await runtime.devices.list())[0].loaded, true)
  assert.equal((await write({ kind: 'device', data: { name: 'sensor', loaded: false } })).isError, true)
})

test('profile writing respects invocation permissions, configured denial and cancellation', async t => {
  const { runtime, capabilities, directory } = await fixture(t)
  await seed(runtime)
  await assert.rejects(capabilities.tools.call('profile_write', { kind: 'device', data: { name: 'sensor' } }, {
    directory, sessionID: 'denied', abort: new AbortController().signal,
    ask: async permission => { throw new PermissionDeniedError(permission.permission) }, questions: async () => ({}),
  }), PermissionDeniedError)
  assert.equal(kinexPermissionAction('profile_write', {}), 'allow')
  assert.equal(kinexPermissionAction('profile_write', { profile_write: 'deny' }), 'deny')
  const closed = new AbortController()
  closed.abort()
  await assert.rejects(runtime.tools.call('profile_write', { kind: 'device', data: { name: 'sensor' } }, { ...call, signal: closed.signal }))
  const noHost = createKinexRuntime({ directory })
  t.after(() => noHost.dispose())
  await assert.rejects(noHost.tools.call('profile_write', { kind: 'device', data: { name: 'sensor' } }, call), PermissionDeniedError)
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
  await writeFile(path.join(directory, '.kinex/tool/profile_write.js'), 'export default {description:"collision", execute: async () => ({title:"bad", output:"bad"})}')
  assert.ok((await capabilities.tools.list()).problems.some(problem => problem.includes('profile_write')))
  const child = path.join(directory, 'nested')
  await mkdir(child)
  const nested = createKinexRuntime({ directory: child})
  t.after(() => nested.dispose())
  assert.equal((await nested.skills.load('setup-device')).content, 'updated procedure')
  await nested.context()
  assert.deepEqual(await readdir(child), [])
})

test('unregister confirms, finalizes capture and fences queued load until deletion', async t => {
  const { runtime, directory } = await fixture(t)
  const marker = await pythonSensor(runtime, directory)
  const command = coreContribution(runtime).commands.find(command => command.name === 'unregister')
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

test('unregister removes unloaded drivers without starting them', async t => {
  for (const persistent of [true, false]) {
    const { runtime, directory, capabilities } = await fixture(t)
    await seed(runtime)
    await runtime.profiles.writeDevice({ name: 'sensor', access: {
      connection: { kind: 'process' },
      driver: { persistent, interpreter: 'missing-interpreter', actions: ['load', 'unload', 'status', 'stop'] },
    } })
    const command = capabilities.commands.find(command => command.name === 'unregister')
    assert.equal((await command.execute('sensor', { ...call, confirm: async () => true })).text, 'sensor unregistered')
    assert.deepEqual(await runtime.devices.list(), [])
    await assert.rejects(stat(path.join(directory, '.kinex/devices/sensor')), { code: 'ENOENT' })
    await assert.rejects(stat(path.join(directory, '.kinex/python')), { code: 'ENOENT' })
  }
})

test('unregister succeeds after unloading a persistent driver with stop', async t => {
  const { runtime, directory } = await fixture(t)
  await pythonSensor(runtime, directory)
  await runtime.profiles.writeDevice({ name: 'sensor', access: { driver: {
    actions: ['load', 'unload', 'status', 'read', 'stop'],
  } } })
  await runtime.devices.unload('sensor')
  await runtime.devices.unregister('sensor')
  assert.deepEqual(await runtime.devices.list(), [])
  await assert.rejects(stat(path.join(directory, '.kinex/devices/sensor')), { code: 'ENOENT' })
})

test('failed deactivation keeps the registered profile and driver', async t => {
  const { runtime, directory } = await fixture(t)
  await pythonSensor(runtime, directory, { fail: true })
  await assert.rejects(runtime.devices.unregister('sensor'), /unload failed/)
  assert.equal((await runtime.devices.list()).length, 1)
  await stat(path.join(directory, '.kinex/devices/sensor/driver.py'))
})


test('device guide discovery is inert, preserves overrides and injects only Use', async t => {
  const { runtime, directory } = await fixture(t)
  const { readDeviceGuide } = await import('../dist/device/guide.js')
  const { resolveDeviceTemplate } = await import('../dist/device/templates.js')
  const { deviceConventions } = await import('../dist/device/conventions.js')
  const templates = await runtime.devices.templates()
  for (const template of templates.filter(entry => entry.kind === 'template')) {
    const guide = await readDeviceGuide(path.join(template.directory, 'DEVICE.md'))
    assert.ok(guide.setup && guide.profile && guide.use, template.name)
    assert.doesNotMatch(guide.setup, /calib_write|calib_plan|Device setup guide roots/)
  }
  assert.ok(await runtime.skills.load('setup-device'))
  await runtime.context()
  assert.deepEqual(await readdir(directory), [])
  const override = path.join(directory, '.kinex/device/templates/model')
  await mkdir(override, { recursive: true })
  await writeFile(path.join(override, 'DEVICE.md'), '---\nname: model\ntype: model\n---\n## Setup\nprivate provisioning\n### Profile\n```yaml\nname: custom\n```\n## Use\ncustom runtime convention\n')
  const child = path.join(directory, 'child')
  await mkdir(child)
  const nested = createKinexRuntime({ directory: child })
  t.after(() => nested.dispose())
  assert.equal((await nested.devices.templates()).find(entry => entry.name === 'model').directory, override)
  const instance = await nested.operation(() => resolveDeviceTemplate(child, 'fastwam', 'model'))
  assert.equal(instance.kind, 'instance')
  assert.equal(instance.name, 'fastwam')
  const legged = await nested.operation(() => resolveDeviceTemplate(child, 'legged_base'))
  assert.equal(legged.kind, 'template')
  assert.equal(legged.name, 'legged_base')
  assert.equal(legged.type, 'legged_base')
  const { deviceGuideProfile } = await import('../dist/device/guide.js')
  const profile = await deviceGuideProfile(path.join(legged.directory, 'DEVICE.md'))
  assert.equal((await runtime.profiles.writeDevice(profile)).loaded, false)
  const conventions = await nested.operation(() => deviceConventions(child, [{ name: 'first', type: 'model' }, { name: 'second', type: 'model' }]))
  assert.equal(conventions.match(/custom runtime convention/g).length, 1)
  assert.doesNotMatch(conventions, /private provisioning|name: custom/)
  await nested.context()
  assert.deepEqual(await readdir(child), [])
})

test('allowed device guides scope shared fallbacks and refresh edits', async t => {
  const { runtime, directory } = await fixture(t)
  await seed(runtime)
  for (const name of ['first', 'second', 'third'])
    await mkdir(path.join(directory, '.kinex/devices', name), { recursive: true })
  const specific = path.join(directory, '.kinex/devices/first/DEVICE.md')
  await writeFile(specific, '## Setup\nprivate instance setup\n## Use\nfirst device convention\n')
  await writeFile(path.join(directory, '.kinex/devices/sensor/DEVICE.md'), '## Use\nunloaded convention\n')
  const child = path.join(directory, 'child')
  await mkdir(child)
  const nested = createKinexRuntime({ directory: child })
  t.after(() => nested.dispose())
  const { deviceConventions } = await import('../dist/device/conventions.js')
  const devices = ['first', 'second', 'third'].map(name => ({ name, type: 'legged_base' }))
  const conventions = () => nested.operation(() => deviceConventions(child, devices))
  const initial = await conventions()
  assert.match(initial, /devices="first">\nfirst device convention/)
  assert.equal(initial.match(/<device_conventions /g).length, 2)
  assert.doesNotMatch(initial, /private instance setup|unloaded convention/)
  const override = path.join(directory, '.kinex/device/templates/legged_base')
  await mkdir(override, { recursive: true })
  await writeFile(path.join(override, 'DEVICE.md'), '## Use\nworkspace type convention\n')
  await writeFile(specific, '## Use\nupdated first convention\n')
  const updated = await conventions()
  assert.match(updated, /devices="first">\nupdated first convention/)
  assert.match(updated, /devices="second, third">\nworkspace type convention/)
  await writeFile(specific, '## Setup\nmissing runtime guidance\n')
  await assert.rejects(conventions(), /first\/DEVICE.md: missing ## Use section/)
  await rm(specific)
  const fallback = await conventions()
  assert.match(fallback, /devices="first, second, third">\nworkspace type convention/)
  assert.equal(fallback.match(/<device_conventions /g).length, 1)
  assert.deepEqual(await readdir(child), [])
  await assert.rejects(stat(path.join(directory, '.kinex/python')), { code: 'ENOENT' })
})

test('context rejects custom guides for unlisted types and recovers after removal', async t => {
  const { runtime, directory } = await fixture(t)
  await seed(runtime)
  await runtime.profiles.writeDevice({ name: 'camera', type: 'rgb', loaded: true })
  const file = path.join(directory, '.kinex/devices/camera/DEVICE.md')
  await writeFile(file, '## Use\ncustom camera convention\n')
  await assert.rejects(runtime.context(), {
    name: 'CustomDeviceGuideError',
    message: /camera\/DEVICE.md: custom DEVICE.md is not allowed for device type "rgb"; allowed types: legged_base/,
  })
  const { deviceConventions } = await import('../dist/device/conventions.js')
  const { DeviceType } = await import('../dist/device/profile/schema.js')
  for (const type of [...DeviceType.options, 'unknown_type']) {
    if (type === 'legged_base') continue
    await assert.rejects(runtime.operation(() => deviceConventions(directory, [{ name: 'camera', type }])), {
      name: 'CustomDeviceGuideError',
    })
  }
  await rm(file)
  assert.match((await runtime.context()).conventions, /type="rgb" devices="camera"/)
})

test('register validates arguments and cancelled unregister preserves files', async t => {
  const { runtime, directory, capabilities } = await fixture(t)
  await seed(runtime)
  const register = capabilities.commands.find(command => command.name === 'register')
  const unregister = capabilities.commands.find(command => command.name === 'unregister')
  const context = { ...call, confirm: async () => true }
  await assert.rejects(register.execute('', context), /Usage/)
  for (const args of ['', 'all', 'sensor extra']) await assert.rejects(unregister.execute(args, context), /Usage/)
  assert.deepEqual(await unregister.choices(), ['sensor'])
  const controller = new AbortController()
  await assert.rejects(unregister.execute('sensor', { ...context, signal: controller.signal,
    confirm: async () => { controller.abort(); return true },
  }), /abort/i)
  await stat(path.join(directory, '.kinex/devices/sensor/profile.yaml'))
  const workflow = await register.execute('rgb $ARGUMENTS', context)
  assert.match(workflow.prompt, /rgb \$ARGUMENTS/)
  assert.match(workflow.prompt, /profile_write/)
  assert.equal((await runtime.devices.list()).length, 1)
})

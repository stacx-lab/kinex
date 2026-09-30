import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
const exec = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))

test('packed setup composes with core in a relocated workspace and can be removed', { timeout: 180000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kinex-setup-package-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const pack = async location => {
    const result = await exec('npm', ['pack', '--json', '--pack-destination', directory], { cwd: location })
    return JSON.parse(result.stdout)[0]
  }
  const core = await pack(path.join(root, '../core'))
  const setup = await pack(root)
  assert.ok(!setup.files.some(file => file.path.includes('assets/builtin/device/') || file.path.includes('/setup-device/')))
  assert.ok(setup.files.some(file => file.path === 'assets/builtin/skill/calibrate-camera-intrinsics/SKILL.md'))
  for (const name of ['driver.py', 'setup.sh', 'provision.py', 'fastwam_config.py', 'artifacts.json', 'requirements.txt', 'DEVICE.md'])
    assert.ok(core.files.some(file => file.path === `assets/builtin/device/fastwam/${name}`))
  assert.ok(!setup.files.some(file => file.path.includes('assets/python/') || file.path.endsWith('.pyc')))
  assert.ok(core.files.some(file => file.path === 'assets/builtin/skill/setup-device/SKILL.md'))
  const installed = path.join(directory, 'installed')
  await exec('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', installed,
    path.join(directory, core.filename), path.join(directory, setup.filename), '@types/node@22'])
  const relocated = path.join(directory, 'relocated')
  await rename(installed, relocated)
  const env = { ...process.env, KINEX_CONFIG_DIR: path.join(directory, 'config'), KINEX_DATA_DIR: path.join(directory, 'data'), PYTHONDONTWRITEBYTECODE: '1' }
  await writeFile(path.join(relocated, 'consumer.mts'), `
import { createKinexRuntime } from '@kinex/core'
import { composeContributions, coreContribution } from '@kinex/core/integration'
import { createKinexSetup, setupContribution, setupSkillRoots, setupToolNames } from '@kinex/setup'
const runtime = createKinexRuntime({ directory: process.cwd(), builtinSkillRoots: setupSkillRoots, reservedToolNames: setupToolNames })
const setup = createKinexSetup(runtime)
const capabilities = composeContributions([coreContribution(runtime), setupContribution(setup)])
await capabilities.tools.list()
await setup.calibration.plan()
await runtime.dispose()
`)
  await exec(process.execPath, [path.join(root, '../../node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--module', 'NodeNext', '--target', 'ES2023', '--lib', 'ES2024', '--types', 'node', 'consumer.mts'], { cwd: relocated, env })
  await exec(process.execPath, ['--input-type=module', '--eval', `
import assert from 'node:assert/strict'
import { copyFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { createKinexRuntime } from '@kinex/core'
import { deviceGuideProfile } from '@kinex/core/device/guide'
import { createKinexSetup, setupSkillRoots } from '@kinex/setup'
const runtime = createKinexRuntime({directory: process.cwd(), builtinSkillRoots: setupSkillRoots, host: {ask: async () => {}}})
const setup = createKinexSetup(runtime)
try {
  assert.ok((await runtime.skills.load('setup-device')).info.directory.includes('node_modules'))
  await assert.rejects(stat('.kinex'), {code:'ENOENT'})
  const write = async data => {
    const result = await runtime.tools.call('profile_write', data, {sessionID:'provision'})
    assert.ok(!result.isError, result.output)
  }
  await write({kind:'robot', data:{identity:{id:'clock',name:'Clock',platform:'real',kind:'arm'}}})
  const template = (await runtime.devices.templates()).find(template => template.name === 'world')
  const profile = await deviceGuideProfile(path.join(template.directory, 'DEVICE.md'))
  profile.access.driver.interpreter = 'python3'
  await write({kind:'device',data:profile})
  await copyFile(path.join(template.directory, 'driver.py'), '.kinex/devices/world/driver.py')
  await write({kind:'device',data:{name:'sensor',type:'other',access:{connection:{kind:'mock'}}}})
  assert.equal((await runtime.devices.list())[0].loaded, false)
  assert.ok((await setup.calibration.plan()).items.some(item => item.id === 'access:world'))
} finally {await runtime.dispose()}
`], { cwd: relocated, env })
  await rm(path.join(relocated, 'node_modules/@kinex/setup'), { recursive: true })
  await exec(process.execPath, ['--input-type=module', '--eval', `
import assert from 'node:assert/strict'
import { mkdir, symlink, writeFile, stat } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { createKinexRuntime } from '@kinex/core'
import { urdfModel } from '@kinex/core/device/joint-model'
await assert.rejects(import('@kinex/setup'), {code:'ERR_MODULE_NOT_FOUND'})
const runtime = createKinexRuntime({directory: process.cwd(), host:{ask: async () => {}}})
try {
  const tools = (await runtime.tools.list()).tools.map(tool => tool.name)
  for (const name of ['profile_write','device','devices','device_stop','servo','track','settled','relative_pose','locate_object_3d','run_policy']) assert.ok(tools.includes(name), name)
  for (const name of ['calib_plan','calib_write','calib_sample','device_calibrate']) assert.ok(!tools.includes(name), name)
  assert.ok(await runtime.skills.load('setup-device'))
  assert.ok((await runtime.devices.templates()).some(template => template.name === 'fastwam'))
  await assert.rejects(stat('.kinex/python'), {code:'ENOENT'})
  await (await runtime.devices.load('world')).ready
  const first = (await runtime.devices.dispatch('world', 'read')).data.time_s
  assert.ok((await runtime.devices.dispatch('world', 'wait', {duration_s:.02})).data.time_s > first)
  assert.match((await runtime.context()).conventions, /wait.*duration_s/)
  await (await runtime.devices.load('sensor')).ready
  const capture = await runtime.recording.start({sessionID:'operate',specs:{sensor:{rate:5}}})
  assert.deepEqual(capture.refusals, {})
  const snap = await runtime.recording.snap({sessionID:'operate',devices:['sensor']})
  assert.ok(snap.readings.sensor)
  await runtime.recording.stop()
  await (await runtime.devices.reload('world')).ready
  await runtime.devices.ping('world')
  await runtime.devices.unload('world')
  // Model resolution belongs to core even when its Python environment is newly prepared.
  const python = await runtime.python.initialize()
  await mkdir(path.dirname(python.executable), {recursive:true})
  const executable = execFileSync('python3', ['-c','import sys; print(sys.executable)'], {encoding:'utf8'}).trim()
  await symlink(executable, python.executable)
  const urdf = path.resolve('arm.urdf')
  await writeFile(urdf, '<robot name="arm"><link name="base"/><link name="tip"/><joint name="j" type="revolute"><parent link="base"/><child link="tip"/><axis xyz="0 0 1"/><limit lower="-1" upper="1" effort="10" velocity="1"/></joint></robot>')
  const model = await runtime.operation(() => urdfModel(process.cwd(), urdf, 'base', 'tip'))
  assert.equal(model.joints[0].name, 'j')
} finally {await runtime.dispose()}
`], { cwd: relocated, env })
  assert.ok(await readFile(path.join(relocated, '.kinex/devices/world/profile.yaml'), 'utf8'))
})

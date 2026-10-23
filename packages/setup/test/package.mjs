import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const exec = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))

export async function checkSetupPackage(relocated, installed, env, setup) {
  assert.ok(!setup.files.some(file => file.path.includes('assets/builtin/device/') || file.path.includes('/setup-device/')))
  assert.ok(setup.files.some(file => file.path === 'assets/builtin/skill/calibrate-camera-intrinsics/SKILL.md'))
  assert.ok(setup.files.some(file => file.path === 'assets/builtin/skill/verify-base-motion/procedure.json'))
  assert.ok(setup.files.some(file => file.path === 'assets/compute/verify_base.py'))
  assert.ok(!setup.files.some(file => file.path.includes('assets/python/kinex/') || file.path.endsWith('.pyc')))
  assert.ok(setup.files.some(file => file.path === 'assets/builtin/skill/onboard-ros2/SKILL.md'))
  await writeFile(path.join(relocated, 'consumer.mts'), `
import { createKinexRuntime } from '@kinex/core'
import { composeContributions, coreContribution } from '@kinex/core/integration'
import { createKinexSetup, setupContribution, setupSkillRoots, setupToolNames } from '@kinex/setup'
const runtime = createKinexRuntime({ directory: process.cwd(), builtinSkillRoots: setupSkillRoots, reservedToolNames: setupToolNames })
const setup = createKinexSetup(runtime)
const capabilities = composeContributions([coreContribution(runtime), setupContribution(setup)])
await capabilities.tools.list()
await setup.plan.inspect()
await runtime.dispose()
`)
  await exec(process.execPath, [path.join(root, '../../node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--module', 'NodeNext', '--target', 'ES2023', '--lib', 'ES2024', '--types', 'node', 'consumer.mts'], { cwd: relocated, env })
  await exec(process.execPath, ['--input-type=module', '--eval', `
import {protocolDevice} from ${JSON.stringify(new URL('../../core/test/fixtures/protocol.mjs',import.meta.url).href)}
import assert from 'node:assert/strict'
import { copyFile, stat, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { createKinexRuntime } from '@kinex/core'
import { Assets as CoreAssets } from '@kinex/core/installation/assets'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { deviceGuideProfile } from ${JSON.stringify(new URL('../../core/test/fixtures/guide.mjs',import.meta.url).href)}
import { createKinexSetup, setupSkillRoots } from '@kinex/setup'
const runtime = createKinexRuntime({directory: process.cwd(), builtinSkillRoots: setupSkillRoots, host: {ask: async () => {}}})
const setup = createKinexSetup(runtime)
try {
  assert.ok((await runtime.skills.load('setup-device')).info.directory.includes('node_modules'))
  await assert.rejects(stat('.kinex'), {code:'ENOENT'})
  const write = async data => {
    const result = await runtime.tools.call('profile_write', data, {sessionID:'configure'})
    assert.ok(!result.isError, result.output)
  }
  await write({kind:'robot', data:{identity:{id:'clock',name:'Clock',kind:'arm'}}})
  const template = (await runtime.devices.templates()).find(template => template.name === 'world')
  const profile = await deviceGuideProfile(path.join(template.directory, 'DEVICE.md'))
  await write({kind:'device',data:profile})
  await protocolDevice(runtime, process.cwd(), 'sensor')
  assert.equal((await setup.plan.inspect()).taskSatisfied, null)
  assert.ok(await runtime.skills.load('onboard-ros2'))
} finally {await runtime.dispose()}
`], { cwd: relocated, env })
  await rm(path.join(installed, 'node_modules/@kinex/setup'), { recursive: true })
  await exec(process.execPath, ['--input-type=module', '--eval', `
import assert from 'node:assert/strict'
import { mkdir, symlink, writeFile, stat, readFile, readdir } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { createKinexRuntime } from '@kinex/core'
import { urdfTree } from '@kinex/core/device/device-model'
await assert.rejects(import('@kinex/setup'), {code:'ERR_MODULE_NOT_FOUND'})
const runtime = createKinexRuntime({directory: process.cwd(), host:{ask: async () => {}}})
try {
  const tools = (await runtime.tools.list()).tools.map(tool => tool.name)
  for (const name of ['profile_write','device','devices','device_stop','relative_pose','locate_object_3d','run_policy']) assert.ok(tools.includes(name), name)
  for (const name of ['setup_plan','calib_compute','calib_sample']) assert.ok(!tools.includes(name), name)
  assert.ok(await runtime.skills.load('setup-device'))
  assert.ok(!(await runtime.skills.list()).some(skill => skill.name === 'onboard-ros2'))
  assert.ok((await runtime.devices.templates()).some(template => template.name === 'fastwam'))
  await assert.rejects(stat('.kinex/python'), {code:'ENOENT'})
  await (await runtime.devices.load('sensor')).ready
  assert.equal((await runtime.devices.dispatch('sensor','read')).data.value,1)
  const snap = await runtime.recording.snap({sessionID:'operate',devices:['sensor']})
  assert.ok(snap.readings.sensor)
  await runtime.recording.stop()
  await runtime.devices.unload('sensor')
  // Model resolution belongs to core even when its Python environment is newly prepared.
  const python = await runtime.python.initialize()
  await mkdir(path.dirname(python.executable), {recursive:true})
  const executable = execFileSync('python3', ['-c','import sys; print(sys.executable)'], {encoding:'utf8'}).trim()
  await symlink(executable, python.executable)
  const urdf = path.resolve('arm.urdf')
  await writeFile(urdf, '<robot name="arm"><link name="base"/><link name="tip"/><joint name="j" type="revolute"><parent link="base"/><child link="tip"/><axis xyz="0 0 1"/><limit lower="-1" upper="1" effort="10" velocity="1"/></joint></robot>')
  const model = await runtime.operation(() => urdfTree(process.cwd(), urdf, 'base'))
  assert.equal(model.joints[0].name, 'j')
} finally {await runtime.dispose()}
`], { cwd: relocated, env })
  assert.ok(await readFile(path.join(relocated, '.kinex/devices/world/profile.yaml'), 'utf8'))
}

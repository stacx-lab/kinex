import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createKinexRuntime } from '@kinex/core'
import { coreContribution, composeContributions } from '@kinex/core/integration'
import { createKinexSetup, setupContribution, setupSkillRoots, setupToolNames } from '../dist/index.js'

const globals = await mkdtemp(path.join(os.tmpdir(), 'kinex-setup-home-'))
process.env.KINEX_CONFIG_DIR = path.join(globals, 'config')
after(() => rm(globals, { recursive: true, force: true }))
const allow = { ask: async () => {} }
async function fixture(t, host = allow) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kinex-setup-'))
  // Kinex Python defaults to ROS Jazzy; these tests use plain uv Python.
  const runtime = createKinexRuntime({ directory, host, builtinSkillRoots: setupSkillRoots, reservedToolNames: setupToolNames, settings: { python: { provider: 'uv' } } })
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
  assert.deepEqual(setupToolNames, ['setup_plan'])
  assert.equal(tools.tools.filter(tool => tool.name === 'profile_write').length, 1)
  assert.equal(context.sections['setup.guides'], undefined)
})

test('onboarding and calibration share core profile writes and preserve planning purity', async t => {
  const { runtime, setup, directory, capabilities } = await fixture(t)
  await seed(runtime)
  const input = { kind: 'device', data: { name: 'sensor', description: 'Verified sensor' } }
  const result = await capabilities.tools.call('profile_write', input, {
    directory, sessionID: 'onboarding', abort: new AbortController().signal,
    ask: async () => {}, questions: async () => ({}),
  })
  assert.ok(!result.isError, result.output)
  const file = path.join(directory, '.kinex/devices/sensor/profile.yaml')
  const before = await readFile(file, 'utf8')
  await setup.plan.inspect()
  assert.equal(await readFile(file, 'utf8'), before)
  for (const command of setupContribution(setup).commands) {
    const result = await command.execute('', { ...call, confirm: async () => false })
    assert.match(result.prompt, /profile_write/)
  }
})

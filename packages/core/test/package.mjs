import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
const exec = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))

export async function checkCorePackage(directory, env, pack) {
  assert.ok(pack.files.some(file => file.path === 'assets/python/kinex/runtime.py'))
  for (const file of ['srv/Wait.srv', 'srv/Capture.srv', 'package.xml', 'CMakeLists.txt'])
    assert.ok(pack.files.some(entry => entry.path === `assets/ros/kinex_interfaces/${file}`))
  assert.ok(pack.files.some(file => file.path === 'assets/python/kinex/__init__.py'))
  assert.ok(pack.files.some(file => file.path === 'assets/python/kinex/host/run.py'))
  assert.ok(pack.files.some(file => file.path === 'assets/builtin/skill/setup-device/SKILL.md'))
  assert.ok(!pack.files.some(file => /builtin\/skill\/calibrate-/.test(file.path)))
  for (const name of ['node.py', 'env.sh', 'setup.sh', 'provision.py', 'artifacts.json', 'requirements.txt', 'DEVICE.md'])
    assert.ok(pack.files.some(file => file.path === `assets/builtin/device/fastwam/${name}`))
  for (const file of ['helpers/helpers.txt', 'helpers/__init__.py', 'helpers/frames.py', 'helpers/motion.py', 'helpers/policy.py', 'lib/kinematics.py', 'node.py', 'host/urdf.py'])
    assert.ok(pack.files.some(entry => entry.path === `assets/python/kinex/${file}`))
  assert.ok(!pack.files.some(file => file.path.endsWith('.pyc')))
  await writeFile(path.join(directory, 'consumer.mts'), `
    import { createKinexRuntime, type RuntimeOptions } from '@kinex/core'
    import { coreContribution } from '@kinex/core/integration'
    const options: RuntimeOptions = { directory: process.cwd(), host: { ask: async () => {} } }
    const runtime = createKinexRuntime(options)
    const contribution = coreContribution(runtime)
    const tools = await runtime.tools.list()
    await runtime.dispose()
  `)
  await exec(process.execPath, [path.join(root, '../../node_modules/typescript/bin/tsc'),
    '--noEmit', '--strict', '--module', 'NodeNext', '--target', 'ES2023', '--lib', 'ES2024', '--types', 'node', 'consumer.mts'], { cwd: directory })
  const { stdout } = await exec(process.execPath, ['--input-type=module', '--eval', `
    import {protocolDevice, protocolFramePython} from ${JSON.stringify(new URL('./fixtures/protocol.mjs',import.meta.url).href)}
    import assert from 'node:assert/strict'
    import { copyFile, stat, mkdir, writeFile, symlink } from 'node:fs/promises'
    import { execFileSync } from 'node:child_process'
    import path from 'node:path'
    const count = () => process.eventNames().map(name => [name, process.listenerCount(name)])
    const before = count()
    const { createKinexRuntime, executeRoboticsCommand } = await import('@kinex/core')
    const { deviceGuideProfile } = await import(${JSON.stringify(new URL('./fixtures/guide.mjs',import.meta.url).href)})
    const { coreContribution } = await import('@kinex/core/integration')
    await assert.rejects(import('@kinex/setup'), {code:'ERR_MODULE_NOT_FOUND'})
    assert.deepEqual(count(), before)
    assert.equal(globalThis.Bun, undefined)
    const runtime = createKinexRuntime({directory: process.cwd(), host: {ask: async () => {}}})
    assert.deepEqual(count(), before)
    try {
      assert.ok((await runtime.skills.load('setup-device')).info.directory.includes('node_modules'))
      const templates = await runtime.devices.templates()
      await runtime.context()
      await assert.rejects(stat('.kinex'), {code:'ENOENT'})
      assert.equal(runtime.calibration, undefined)
      const context = {sessionID:'register', confirm: async () => true}
      const workflow = await executeRoboticsCommand(runtime, 'register', 'world', context)
      assert.equal(workflow.kind, 'workflow')
      assert.match(workflow.prompt, /profile_write/)
      const write = async data => {
        const result = await runtime.tools.call('profile_write', data, {sessionID:'register'})
        assert.ok(!result.isError, result.output)
      }
      await write({kind:'robot',data:{identity:{id:'clock',name:'Clock',kind:'arm'}}})
      const template = templates.find(template => template.name === 'world')
      const profile = await deviceGuideProfile(path.join(template.directory, 'DEVICE.md'))
      await write({kind:'device',data:profile})
      await protocolFramePython(runtime)
      await protocolDevice(runtime, process.cwd(), 'world', {type:'world',description:'World description',loaded:true})
      assert.equal((await runtime.devices.list())[0].loaded, true)
      const capabilities = coreContribution(runtime)
      assert.ok(capabilities.commands.some(command => command.name === 'unregister'))
      assert.equal('conventions' in await runtime.context(),false)
      const listed = await runtime.tools.call('exec', { python: 'from kinex import runtime, finish\\nfinish(runtime.devices())' }, {sessionID:'package'})
      assert.ok(!listed.isError, listed.output)
      assert.equal(JSON.parse(listed.output).result[0].name, 'world')
      const reading = await runtime.tools.call('device', { deviceID: 'world', action: 'read' }, {sessionID:'package'})
      assert.ok(!reading.isError, reading.output)
      const batch = await runtime.tools.call('devices', { calls: [{ deviceID: 'world', action: 'read' }] }, {sessionID:'package'})
      assert.equal(JSON.parse(batch.output).results[0].ok, true)
      await executeRoboticsCommand(runtime, 'unregister', 'world', context)
      await assert.rejects(stat('.kinex/devices/world'), {code:'ENOENT'})
      const python = (await runtime.context()).python.library
      execFileSync('python3', ['-c', 'import kinex; import kinex.runtime; import kinex.lib.camera; import kinex.helpers.policy; import kinex.lib.kinematics'], {
        env: {...process.env, PYTHONPATH: python, PYTHONDONTWRITEBYTECODE: '1'}
      })
      execFileSync('python3', ['-c', [
        'from kinex.lib.kinematics import DEFAULTS, Chain, budget_options',
        'import sys',
        'from kinex.helpers import trajectory, lookup_transform',
        'assert callable(lookup_transform) and "rclpy" not in sys.modules',
        'assert budget_options({}) == dict(max_attempts=5, attempt_time_s=.02, max_time_s=.1)',
        'joints = [dict(name="x", type="prismatic", limits=dict(min=0, max=1))]',
        'plan = trajectory(joints, [0], [.4], .01)',
        'assert plan.actions[-1] == [.4] and plan.duration_s > 0',
        'tree = dict(base_link="base", joints=[dict(joints[0], parent="base", child="tip", origin=[0,0,0,0,0,0,1], axis=[1,0,0], mimic=None)])',
        'assert Chain(tree, "tip").ik([.4,0,0,0,0,0,1], dict(x=.4), DEFAULTS) == dict(x=.4)',
      ].join('\\n')], { env: {...process.env, PYTHONPATH: python, PYTHONDONTWRITEBYTECODE: '1'} })
      const tools = await runtime.tools.list()
      assert.ok(tools.tools.some(tool => tool.name === 'device'))
      assert.ok(tools.tools.some(tool => tool.name === 'exec'))
      const script = await runtime.tools.call('exec', {
        python: 'from kinex import robot; print(robot()["identity"]["id"])'
      }, {sessionID:'package'})
      assert.ok(!script.isError, script.output)
      assert.deepEqual(JSON.parse(script.output), {output:'clock\\n', result:null})
      await mkdir('.kinex/tools', {recursive:true})
      await writeFile('.kinex/tools/echo.ts', 'const text: string = "installed"; export default {description: text, execute: async () => ({title: text, output: text})}')
      assert.equal((await runtime.tools.call('echo', {}, {sessionID:'package'})).output, 'installed')
      console.log('packed Node package passed')
    } finally { await runtime.dispose() }
    assert.deepEqual(count(), before)
  `], { cwd: directory, env })
  assert.match(stdout, /packed Node package passed/)
}

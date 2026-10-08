import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
const exec = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))

export async function checkCorePackage(directory, env, pack) {
  assert.ok(pack.files.some(file => file.path === 'assets/python/kinex/__init__.py'))
  assert.ok(pack.files.some(file => file.path === 'assets/builtin/skill/setup-device/SKILL.md'))
  assert.ok(!pack.files.some(file => /builtin\/skill\/calibrate-/.test(file.path)))
  for (const name of ['driver.py', 'setup.sh', 'provision.py', 'fastwam_config.py', 'artifacts.json', 'requirements.txt', 'DEVICE.md'])
    assert.ok(pack.files.some(file => file.path === `assets/builtin/device/fastwam/${name}`))
  assert.ok(pack.files.some(file => file.path === 'assets/python/kinex/policy.py'))
  assert.ok(pack.files.some(file => file.path === 'assets/python/kinex/ik_search.py'))
  assert.ok(pack.files.some(file => file.path === 'assets/python/kinex/trajectory.py'))
  for (const name of ['ros2', 'ros2_drivers', 'ros2_check', 'bundle', 'bundle_manifest', 'bundle_install', 'bundle_render'])
    assert.ok(!pack.files.some(file => file.path === `assets/python/kinex/${name}.py`))
  assert.ok(!pack.files.some(file => file.path.startsWith('test/')))
  assert.ok(!pack.files.some(file => file.path.endsWith('.pyc')))
  await writeFile(path.join(directory, 'consumer.mts'), `
    import { createKinexRuntime, type RuntimeOptions } from '@kinex/core'
    import { DEVICE_USE } from '@kinex/core/context/index'
    const options: RuntimeOptions = { directory: process.cwd(), host: { ask: async () => {} } }
    const runtime = createKinexRuntime(options)
    const text: string = DEVICE_USE
    const tools = await runtime.tools.list()
    await runtime.dispose()
  `)
  await exec(process.execPath, [path.join(root, '../../node_modules/typescript/bin/tsc'),
    '--noEmit', '--strict', '--module', 'NodeNext', '--target', 'ES2023', '--lib', 'ES2024', '--types', 'node', 'consumer.mts'], { cwd: directory })
  const { stdout } = await exec(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict'
    import { copyFile, stat, mkdir, writeFile } from 'node:fs/promises'
    import { execFileSync } from 'node:child_process'
    import path from 'node:path'
    const count = () => process.eventNames().map(name => [name, process.listenerCount(name)])
    const before = count()
    const { createKinexRuntime, executeRoboticsCommand } = await import('@kinex/core')
    const { deviceGuideProfile } = await import('@kinex/core/device/guide')
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
      assert.doesNotMatch(workflow.prompt, /calib_plan|calib_write|device_calibrate/)
      const write = async data => {
        const result = await runtime.tools.call('profile_write', data, {sessionID:'register'})
        assert.ok(!result.isError, result.output)
      }
      await write({kind:'robot',data:{identity:{id:'clock',name:'Clock',platform:'real',kind:'arm'}}})
      const template = templates.find(template => template.name === 'world')
      const profile = await deviceGuideProfile(path.join(template.directory, 'DEVICE.md'))
      profile.access.driver.interpreter = 'python3'
      await write({kind:'device',data:profile})
      await copyFile(path.join(template.directory, 'driver.py'), '.kinex/devices/world/driver.py')
      assert.equal((await runtime.devices.list())[0].loaded, false)
      const capabilities = coreContribution(runtime)
      assert.ok(capabilities.commands.some(command => command.name === 'unregister'))
      await executeRoboticsCommand(runtime, 'load', 'world', context)
      const first = (await runtime.devices.dispatch('world', 'read')).data.time_s
      assert.ok((await runtime.devices.dispatch('world', 'wait', {duration_s:.02})).data.time_s > first)
      const conventions = (await runtime.context()).conventions
      assert.match(conventions, /wait.*duration_s/)
      assert.doesNotMatch(conventions, /### Profile|## Setup|loaded: false/)
      await executeRoboticsCommand(runtime, 'unregister', 'world', context)
      await assert.rejects(stat('.kinex/devices/world'), {code:'ENOENT'})
      const python = (await runtime.context()).python.library
      execFileSync('python3', ['-c', 'import sys; import kinex; import kinex.driver_protocol; import kinex.stream; import kinex.policy; import kinex.kinematics; assert "rclpy" not in sys.modules'], {
        env: {...process.env, PYTHONPATH: python, PYTHONDONTWRITEBYTECODE: '1'}
      })
      execFileSync('python3', ['-c', [
        'from kinex.ik_search import budget_options',
        'from kinex.kinematics import Kinematics',
        'assert budget_options({}) == dict(max_attempts=5, attempt_time_s=.02, max_time_s=.1)',
        'joints = [dict(name="x", type="prismatic", limits=dict(min=0, max=1))]',
        'chain = [dict(origin=[0,0,0,0,0,0,1], joint=0, axis=[1,0,0], anchor=[0,0,0], reference=0)]',
        'ik = dict(max_iterations=200, damping=.01, position_tolerance_m=.001, rotation_tolerance_rad=.001)',
        'model = Kinematics(dict(joints=joints, chain=chain), ik)',
        'assert model.ik([.4,0,0,0,0,0,1], [.4]) == dict(joints=[.4])',
      ].join('\\n')], { env: {...process.env, PYTHONPATH: python, PYTHONDONTWRITEBYTECODE: '1'} })
      const tools = await runtime.tools.list()
      assert.ok(tools.tools.some(tool => tool.name === 'device'))
      await mkdir('.kinex/tool', {recursive:true})
      await writeFile('.kinex/tool/echo.ts', 'const text: string = "installed"; export default {description: text, execute: async () => ({title: text, output: text})}')
      assert.equal((await runtime.tools.call('echo', {}, {sessionID:'package'})).output, 'installed')
      console.log('packed Node package passed')
    } finally { await runtime.dispose() }
    assert.deepEqual(count(), before)
  `], { cwd: directory, env })
  assert.match(stdout, /packed Node package passed/)
}

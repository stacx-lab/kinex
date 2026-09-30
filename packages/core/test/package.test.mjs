import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'
const exec = promisify(execFile)

test('packed package runs in an unrelated directory without Bun or repository assets', { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kinex-package-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const env = { ...process.env, KINEX_CONFIG_DIR: path.join(directory, 'config'), KINEX_DATA_DIR: path.join(directory, 'data') }
  const root = fileURLToPath(new URL('../', import.meta.url))
  const packed = await exec('npm', ['pack', '--json', '--pack-destination', directory], { cwd: root })
  const [pack] = JSON.parse(packed.stdout)
  assert.ok(pack.files.some(file => file.path === 'assets/python/kinex/__init__.py'))
  assert.ok(!pack.files.some(file => /builtin\/(skill|device\/fastwam)/.test(file.path)))
  assert.ok(pack.files.some(file => file.path === 'assets/python/kinex/policy.py'))
  assert.ok(!pack.files.some(file => file.path.endsWith('.pyc')))
  await exec('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', path.join(directory, pack.filename), '@types/node@22'], { cwd: directory })
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
    import { readFile, mkdir, writeFile } from 'node:fs/promises'
    import { execFileSync } from 'node:child_process'
    import path from 'node:path'
    const count = () => process.eventNames().map(name => [name, process.listenerCount(name)])
    const before = count()
    const { createKinexRuntime } = await import('@kinex/core')
    assert.deepEqual(count(), before)
    assert.equal(globalThis.Bun, undefined)
    const runtime = createKinexRuntime({directory: process.cwd()})
    assert.deepEqual(count(), before)
    try {
      assert.equal(await runtime.skills.load('setup-device'), undefined)
      assert.equal(runtime.devices.templates, undefined)
      assert.equal(runtime.devices.unregister, undefined)
      assert.equal(runtime.calibration, undefined)
      const python = (await runtime.context()).python.library
      execFileSync('python3', ['-c', 'import kinex; import kinex.driver_protocol; import kinex.stream; import kinex.policy; import kinex.kinematics'], {
        env: {...process.env, PYTHONPATH: python, PYTHONDONTWRITEBYTECODE: '1'}
      })
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
})

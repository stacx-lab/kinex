import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, rm, rename, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkCorePackage } from '../packages/core/test/package.mjs'
import { checkSetupPackage } from '../packages/setup/test/package.mjs'
const exec = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))

test('standalone, setup and core tarballs install and relocate without plugin packages', { timeout: 180000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kinex-install-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const pack = async cwd => {
    const { stdout } = await exec('npm', ['pack', '--json', '--pack-destination', directory], { cwd })
    return JSON.parse(stdout)[0]
  }
  const core = await pack(path.join(root, 'packages/core'))
  const setup = await pack(path.join(root, 'packages/setup'))
  const standalone = await pack(root)
  const installed = path.join(directory, 'installed')
  let relocated = path.join(directory, 'relocated')
  const env = { ...process.env, KINEX_CONFIG_DIR: path.join(directory, 'config'), KINEX_DATA_DIR: path.join(directory, 'data'), PYTHONDONTWRITEBYTECODE: '1' }
  for (const name of Object.keys(env)) if (name.endsWith('API_KEY') || name.endsWith('API_TOKEN')) delete env[name]
  const install = (prefix, ...packages) => exec('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', prefix,
    ...packages.map(pack => path.join(directory, pack.filename)), '@types/node@22'])
  await install(installed, core)
  await rename(installed, relocated)
  const coreWorkspace = path.join(relocated, 'core-consumer')
  await mkdir(coreWorkspace)
  await t.test('core installs independently with runtime assets and public types', () => checkCorePackage(coreWorkspace, env, core))
  await install(relocated, setup)
  await rename(relocated, relocated + '-setup')
  relocated += '-setup'
  const setupWorkspace = path.join(relocated, 'setup-consumer')
  await mkdir(setupWorkspace)
  await t.test('setup composes, relocates and can be removed', () => checkSetupPackage(setupWorkspace, relocated, env, setup))
  await install(relocated, setup, standalone)
  await rename(relocated, relocated + '-standalone')
  relocated += '-standalone'
  for (const name of ['pi', 'opencode', 'codex']) await assert.rejects(stat(path.join(relocated, 'node_modules/@kinex', name)), { code: 'ENOENT' })
  const entry = path.join(relocated, 'node_modules/kinex/bin/kinex.mjs')
  const invoke = (...args) => {
    const pending = exec(process.execPath, [entry, ...args], { cwd: relocated, env, timeout: 20000 })
    pending.child.stdin.end()
    return pending
  }
  const manifest = JSON.parse(await readFile(path.join(relocated, 'node_modules/kinex/package.json'), 'utf8'))
  for (const name of ['pi-web-search', 'pi-btw']) assert.equal(manifest.dependencies[name], undefined)
  assert.equal((await invoke('--version')).stdout.trim(), manifest.version)
  for (const name of ['core', 'setup']) {
    const dependency = JSON.parse(await readFile(path.join(relocated, `node_modules/@kinex/${name}/package.json`), 'utf8'))
    assert.equal(dependency.version, manifest.version)
    assert.equal(manifest.dependencies[`@kinex/${name}`], manifest.version)
    if (name === 'setup') assert.equal(dependency.dependencies['@kinex/core'], manifest.version)
  }
  assert.match((await invoke('--help')).stdout, /--enable-recording/)
  assert.match((await invoke('-p', '/devices')).stdout, /No devices/)
  await exec(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict'
    import { createApplication } from './node_modules/kinex/dist/application.js'
    const app = await createApplication({ cwd: process.cwd() })
    try {
      await app.host.session.bindExtensions({ mode: 'print' })
      assert.ok(app.host.session.getAllTools().some(tool => tool.name === 'web_search'))
      assert.ok(app.host.session.extensionRunner.getCommand('btw'))
      assert.ok(app.host.session.extensionRunner.getCommand('onboarding'))
      for (const name of ['onboarding-ros2', 'kinex-onboarding-ros2']) assert.equal(app.host.session.extensionRunner.getCommand(name), undefined)
    } finally { await app.dispose() }
  `], { cwd: relocated, env, timeout: 20000 })
  const session = JSON.stringify({ type: 'session', version: 2, id: 'packaged-export', timestamp: new Date().toISOString(), cwd: relocated }) + '\n'
  await writeFile(path.join(relocated, 'session.jsonl'), session)
  assert.match((await invoke('--export', 'session.jsonl')).stdout, /Exported to: pi-session-session.html/)
  assert.match(await readFile(path.join(relocated, 'pi-session-session.html'), 'utf8'), /<!DOCTYPE html>/)
  assert.equal(await readFile(path.join(relocated, 'session.jsonl'), 'utf8'), session)
  await assert.rejects(stat(path.join(relocated, '.pi')), { code: 'ENOENT' })
  await assert.rejects(stat(path.join(relocated, '.kinex/python')), { code: 'ENOENT' })
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm, rename, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const exec = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))

test('four tarballs install and relocate, with adapters independent of standalone', { timeout: 180000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kinex-install-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const pack = async cwd => {
    const { stdout } = await exec('npm', ['pack', '--json', '--pack-destination', directory], { cwd })
    return path.join(directory, JSON.parse(stdout)[0].filename)
  }
  const core = await pack(path.join(root, 'packages/core'))
  const pi = await pack(path.join(root, 'packages/pi'))
  const opencode = await pack(path.join(root, 'packages/opencode'))
  const standalone = await pack(root)
  const installed = path.join(directory, 'installed')
  await exec('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', installed, core, pi, standalone])
  const relocated = path.join(directory, 'relocated')
  await rename(installed, relocated)
  await assert.rejects(stat(path.join(relocated, 'node_modules/@kinex/opencode')), { code: 'ENOENT' })
  const env = { ...process.env, KINEX_CONFIG_DIR: path.join(directory, 'config'), KINEX_DATA_DIR: path.join(directory, 'data') }
  for (const name of Object.keys(env)) if (name.endsWith('API_KEY') || name.endsWith('API_TOKEN')) delete env[name]
  const entry = path.join(relocated, 'node_modules/kinex/bin/kinex.mjs')
  const invoke = (...args) => exec(process.execPath, [entry, ...args], { cwd: relocated, env, timeout: 20000 })
  const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  assert.equal((await invoke('--version')).stdout.trim(), version)
  assert.match((await invoke('--help')).stdout, /--enable-recording/)
  assert.match((await invoke('run', '/devices')).stdout, /No devices/)
  await assert.rejects(stat(path.join(relocated, '.pi')), { code: 'ENOENT' })
  await assert.rejects(stat(path.join(relocated, '.kinex/python')), { code: 'ENOENT' })
  const plugins = path.join(directory, 'plugins')
  await exec('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', plugins, core, pi, opencode, '@earendil-works/pi-coding-agent@0.86.1'])
  const movedPlugins = path.join(directory, 'moved-plugins')
  await rename(plugins, movedPlugins)
  await assert.rejects(stat(path.join(movedPlugins, 'node_modules/kinex')), { code: 'ENOENT' })
  const { stdout } = await exec(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import pi from '@kinex/pi';
    import server from '@kinex/opencode/server';
    import tui from '@kinex/opencode/tui';
    import { createKinexRuntime } from '@kinex/core';
    import { coreContribution, composeContributions } from '@kinex/core/integration';
    assert.equal(typeof pi, 'function'); assert.equal(typeof server.server, 'function'); assert.equal(typeof tui.tui, 'function');
    const runtime = createKinexRuntime({ directory: process.cwd() });
    try {
      const capabilities = composeContributions([coreContribution(runtime)]);
      assert.ok((await capabilities.skills.list()).length > 0);
      assert.ok((await capabilities.tools.list()).tools.some(tool => tool.name === 'device'));
      console.log((await capabilities.commands.find(command => command.name === 'devices').execute('', { sessionID: 'package', confirm: async () => false })).text);
    } finally { await runtime.dispose(); }
  `], { cwd: movedPlugins, env, timeout: 20000 })
  assert.match(stdout, /No devices/)
})

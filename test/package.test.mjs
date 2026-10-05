import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm, rename, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const exec = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))

test('standalone, setup and core tarballs install and relocate without plugin packages', { timeout: 180000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kinex-install-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const pack = async cwd => {
    const { stdout } = await exec('npm', ['pack', '--json', '--pack-destination', directory], { cwd })
    return path.join(directory, JSON.parse(stdout)[0].filename)
  }
  const core = await pack(path.join(root, 'packages/core'))
  const setup = await pack(path.join(root, 'packages/setup'))
  const standalone = await pack(root)
  const installed = path.join(directory, 'installed')
  await exec('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', installed, core, setup, standalone])
  const relocated = path.join(directory, 'relocated')
  await rename(installed, relocated)
  for (const name of ['pi', 'opencode', 'codex']) await assert.rejects(stat(path.join(relocated, 'node_modules/@kinex', name)), { code: 'ENOENT' })
  const env = { ...process.env, KINEX_CONFIG_DIR: path.join(directory, 'config'), KINEX_DATA_DIR: path.join(directory, 'data') }
  for (const name of Object.keys(env)) if (name.endsWith('API_KEY') || name.endsWith('API_TOKEN')) delete env[name]
  const entry = path.join(relocated, 'node_modules/kinex/bin/kinex.mjs')
  const invoke = (...args) => exec(process.execPath, [entry, ...args], { cwd: relocated, env, timeout: 20000 })
  const manifest = JSON.parse(await readFile(path.join(relocated, 'node_modules/kinex/package.json'), 'utf8'))
  assert.equal((await invoke('--version')).stdout.trim(), manifest.version)
  assert.match((await invoke('--help')).stdout, /--enable-recording/)
  assert.match((await invoke('run', '/devices')).stdout, /No devices/)
  const session = JSON.stringify({ type: 'session', version: 2, id: 'packaged-export', timestamp: new Date().toISOString(), cwd: relocated }) + '\n'
  await writeFile(path.join(relocated, 'session.jsonl'), session)
  assert.match((await invoke('--export', 'session.jsonl')).stdout, /Exported to: pi-session-session.html/)
  assert.match(await readFile(path.join(relocated, 'pi-session-session.html'), 'utf8'), /<!DOCTYPE html>/)
  assert.equal(await readFile(path.join(relocated, 'session.jsonl'), 'utf8'), session)
  await assert.rejects(stat(path.join(relocated, '.pi')), { code: 'ENOENT' })
  await assert.rejects(stat(path.join(relocated, '.kinex/python')), { code: 'ENOENT' })
})

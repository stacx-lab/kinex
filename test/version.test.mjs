import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { checkVersion, syncVersion } from '../script/version.mjs'

const files = ['VERSION', 'package.json', 'package-lock.json', 'packages/core/package.json', 'packages/setup/package.json']
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'kinex-version-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  for (const file of [...files, 'script/version.mjs', 'script/release.mjs']) {
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true })
    await cp(new URL(`../${file}`, import.meta.url), path.join(directory, file))
  }
  return directory
}
const contents = directory => Promise.all(files.map(file => readFile(path.join(directory, file), 'utf8')))

test('version sync changes owned metadata, preserves dependency resolutions and is idempotent', async t => {
  const directory = await fixture(t)
  const before = JSON.parse(await readFile(path.join(directory, 'package-lock.json'), 'utf8'))
  await writeFile(path.join(directory, 'VERSION'), '0.11.0\n')
  const unsynced = await contents(directory)
  await assert.rejects(checkVersion(directory), /package-lock.json.*version must be 0.11.0/s)
  assert.deepEqual(await contents(directory), unsynced)
  assert.equal((await syncVersion(directory)).length, 4)
  const state = await checkVersion(directory)
  assert.ok(state.packages.every(pkg => pkg.version === '0.11.0'))
  const after = JSON.parse(await readFile(path.join(directory, 'package-lock.json'), 'utf8'))
  for (const [name, entry] of Object.entries(before.packages)) {
    if (name.startsWith('node_modules/')) assert.deepEqual(after.packages[name], entry)
  }
  const synced = await contents(directory)
  assert.deepEqual(await syncVersion(directory), [])
  assert.deepEqual(await contents(directory), synced)
})

test('checks identify missing pins and stale lock entries even when manifest versions match', async t => {
  const directory = await fixture(t)
  const manifest = path.join(directory, 'package.json')
  const data = JSON.parse(await readFile(manifest, 'utf8'))
  delete data.dependencies['@kinex/core']
  await writeFile(manifest, JSON.stringify(data))
  await assert.rejects(checkVersion(directory), /dependencies.@kinex\/core/)
  await syncVersion(directory)
  const lock = path.join(directory, 'package-lock.json')
  const metadata = JSON.parse(await readFile(lock, 'utf8'))
  metadata.packages['packages/setup'].version = '99.0.0'
  await writeFile(lock, JSON.stringify(metadata))
  await assert.rejects(checkVersion(directory), /packages\[packages\/setup\].version/)
  await syncVersion(directory)
  await checkVersion(directory)
})

test('invalid or missing canonical versions cannot partially rewrite metadata', async t => {
  const directory = await fixture(t)
  for (const value of ['', 'v0.10.0', '0.10', '01.10.0', '0.10.0-rc.1', '0.10.0\n0.11.0']) {
    await writeFile(path.join(directory, 'VERSION'), value)
    const before = await contents(directory)
    await assert.rejects(syncVersion(directory), /MAJOR.MINOR.PATCH/)
    assert.deepEqual(await contents(directory), before)
  }
  await rm(path.join(directory, 'VERSION'))
  await assert.rejects(checkVersion(directory), { code: 'ENOENT' })
})

test('release check enforces the canonical tag and reads no caller working-directory files', async t => {
  const directory = await fixture(t)
  const version = (await readFile(path.join(directory, 'VERSION'), 'utf8')).trim()
  const release = path.join(directory, 'script/release.mjs')
  const before = await contents(directory)
  execFileSync(process.execPath, [release, '--check', '--tag', `v${version}`], { cwd: tmpdir() })
  assert.throws(() => execFileSync(process.execPath, [release, '--check', '--tag', 'v99.0.0'], { stdio: 'pipe' }), /Release tag must match/)
  assert.deepEqual(await contents(directory), before)
})

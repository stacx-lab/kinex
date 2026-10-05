import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const workspaces = [
  { location: 'packages/core', name: '@kinex/core', dependencies: [] },
  { location: 'packages/setup', name: '@kinex/setup', dependencies: ['@kinex/core'] },
  { location: '', name: 'kinex', dependencies: ['@kinex/core', '@kinex/setup'] },
]

export async function versionState(directory = root) {
  const version = (await readFile(path.join(directory, 'VERSION'), 'utf8')).trim()
  assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'VERSION must contain MAJOR.MINOR.PATCH')
  const files = new Map()
  const drift = []
  async function json(file) {
    const original = await readFile(path.join(directory, file), 'utf8')
    const data = JSON.parse(original)
    files.set(file, { original, data })
    return data
  }
  function set(file, data, key, label = key) {
    if (data[key] !== version) {
      drift.push(`${file}: ${label} must be ${version}`)
      data[key] = version
    }
  }
  const packages = []
  for (const { location, name } of workspaces) {
    const file = path.join(location, 'package.json')
    const manifest = await json(file)
    assert.equal(manifest.name, name, `${file}: unexpected package name`)
    set(file, manifest, 'version')
    packages.push({ location, ...manifest })
  }
  const lockFile = 'package-lock.json'
  const lock = await json(lockFile)
  assert.equal(lock.lockfileVersion, 3, 'Expected npm lockfile v3')
  set(lockFile, lock, 'version')
  for (const pkg of packages) {
    const file = path.join(pkg.location, 'package.json')
    const entry = lock.packages[pkg.location]
    assert.ok(entry, `Missing lockfile workspace: ${pkg.name}`)
    set(lockFile, entry, 'version', `packages[${pkg.location}].version`)
    for (const dependency of workspaces.find(workspace => workspace.name === pkg.name).dependencies) {
      assert.ok(pkg.dependencies, `Missing manifest dependencies: ${pkg.name}`)
      set(file, pkg.dependencies, dependency, `dependencies.${dependency}`)
      assert.ok(entry.dependencies, `Missing lockfile dependencies: ${pkg.name}`)
      set(lockFile, entry.dependencies, dependency, `packages[${pkg.location}].dependencies.${dependency}`)
    }
  }
  return { version, packages, files, drift }
}

export async function checkVersion(directory = root) {
  const state = await versionState(directory)
  if (state.drift.length) throw new Error(`${state.drift.join('\n')}\nRun npm run version:sync`)
  return state
}

export async function syncVersion(directory = root) {
  const state = await versionState(directory)
  const changed = []
  for (const [file, { original, data }] of state.files) {
    if (JSON.stringify(JSON.parse(original)) === JSON.stringify(data)) continue
    await writeFile(path.join(directory, file), JSON.stringify(data, null, 2) + '\n')
    changed.push(file)
  }
  return changed
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  assert.ok(args.length === 1 && ['--sync', '--check'].includes(args[0]), 'Usage: node script/version.mjs --sync|--check')
  if (args[0] === '--sync') {
    for (const file of await syncVersion()) console.log(`Updated ${file}`)
  } else {
    console.log(`Versions match ${(await checkVersion()).version}`)
  }
}

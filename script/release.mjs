import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const locations = ['packages/core', '.']
const packages = await Promise.all(locations.map(async location => ({ location, ...JSON.parse(await readFile(path.join(root, location, 'package.json'), 'utf8')) })))
const version = packages.at(-1).version
const tagIndex = process.argv.indexOf('--tag')
if (tagIndex >= 0) assert.equal(process.argv[tagIndex + 1], `v${version}`, 'Release tag must match package versions')
for (const pkg of packages) {
  assert.equal(pkg.version, version, `${pkg.name} version differs`)
  for (const dependency of packages) {
    const requested = pkg.dependencies?.[dependency.name]
    if (requested) assert.equal(requested, dependency.version, `${pkg.name} must pin ${dependency.name}`)
  }
}
if (!process.argv.includes('--check')) {
  const output = process.argv[2]
  if (!output || output.startsWith('--')) throw new Error('Usage: node script/release.mjs OUTPUT_DIRECTORY [--tag vVERSION], or --check [--tag vVERSION]')
  const directory = path.resolve(output)
  if (directory === path.join(root, 'dist') || directory.startsWith(path.join(root, 'dist') + path.sep)) throw new Error('Pack outside dist to avoid recursive tarballs')
  await mkdir(directory, { recursive: true })
  const checksums = []
  for (const pkg of packages) {
    const [packed] = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', directory], { cwd: path.join(root, pkg.location), encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }))
    const bytes = await readFile(path.join(directory, packed.filename))
    checksums.push(`${createHash('sha256').update(bytes).digest('hex')}  ${packed.filename}`)
  }
  await writeFile(path.join(directory, 'SHA256SUMS'), checksums.join('\n') + '\n')
}

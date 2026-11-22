import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

test('self-improve imports only core package exports, Node APIs and declared dependencies', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  // Standalone bundles self-improve; a regular dependency would be bundled with it, core included.
  assert.equal(manifest.dependencies, undefined, 'self-improve declares its dependencies as peers')
  const declared = manifest.peerDependencies
  for (const name of Object.keys(declared)) assert.doesNotMatch(name, /(^|\/)pi-|opentui|anthropic|openai/)
  for (const entry of await readdir(path.join(root, 'src'), { recursive: true })) {
    if (!entry.endsWith('.ts')) continue
    const file = path.join(root, 'src', entry)
    for (const match of (await readFile(file, 'utf8')).matchAll(/(?:from\s*|import\s*\()\s*["']([^"']+)["']/g)) {
      const specifier = match[1]
      if (specifier.startsWith('.')) assert.ok(path.resolve(path.dirname(file), specifier).startsWith(path.resolve(root) + path.sep), specifier)
      else assert.ok(specifier.startsWith('node:') || specifier.startsWith('@kinex/core/') || specifier in declared, specifier)
    }
  }
})

// src/jobs serves any agent host, so it may know none: not Kinex, not Pi, not the rest of this package.
test('jobs imports only Node APIs and its own files', async () => {
  const root = fileURLToPath(new URL('../src/jobs/', import.meta.url))
  const files = (await readdir(root, { recursive: true })).filter(entry => entry.endsWith('.ts'))
  assert.deepEqual(files.sort(), ['index.ts', 'tools.ts'])
  for (const entry of files) {
    const file = path.join(root, entry)
    for (const match of (await readFile(file, 'utf8')).matchAll(/(?:from\s*|import\s*\()\s*["']([^"']+)["']/g))
      assert.ok(match[1].startsWith('node:') || (match[1].startsWith('./') && path.resolve(path.dirname(file), match[1]).startsWith(root)), `${entry}: ${match[1]}`)
  }
})

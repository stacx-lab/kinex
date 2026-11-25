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

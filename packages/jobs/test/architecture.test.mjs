import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// The package serves any agent host, so it may know none: not Kinex, not Pi.
test('jobs imports only Node APIs and its own files', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  assert.equal(manifest.dependencies, undefined)
  assert.equal(manifest.peerDependencies, undefined)
  for (const entry of await readdir(path.join(root, 'src'), { recursive: true })) {
    if (!entry.endsWith('.ts')) continue
    for (const match of (await readFile(path.join(root, 'src', entry), 'utf8')).matchAll(/(?:from\s*|import\s*\()\s*["']([^"']+)["']/g))
      assert.ok(match[1].startsWith('node:') || match[1].startsWith('./'), `${entry}: ${match[1]}`)
  }
})

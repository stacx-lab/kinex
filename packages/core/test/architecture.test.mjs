import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
test('core source imports stay inside the package and have no host dependencies', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  assert.ok(!('@kinex/setup' in manifest.dependencies))
  const allowed = new Set(Object.keys(manifest.dependencies))
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) { await visit(file); continue }
      if (!file.endsWith('.ts')) continue
      const source = await readFile(file, 'utf8')
      for (const match of source.matchAll(/(?:from\s*|import\s*\()\s*["']([^"']+)["']/g)) {
        const specifier = match[1]
        if (specifier.startsWith('.')) {
          assert.ok(path.resolve(directory, specifier).startsWith(root), `${file}: ${specifier}`)
          continue
        }
        assert.ok(specifier.startsWith('node:') || allowed.has(specifier), `${file}: ${specifier}`)
      }
      assert.doesNotMatch(source, /\bBun\.(?:file|spawn|Glob|write|build|which)\b/, file)
    }
  }
  await visit(path.join(root, 'src'))
  for (const name of allowed) assert.doesNotMatch(name, /pi-coding-agent|opentui|anthropic|openai/)
})

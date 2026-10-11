import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parseFrontmatter } from '../dist/skill/index.js'

test('core skill frontmatter parses LF and Windows CRLF identically', async () => {
  const source = (await readFile(new URL('../assets/builtin/skill/setup-device/SKILL.md', import.meta.url), 'utf8')).replaceAll('\r\n', '\n')
  const parsed = parseFrontmatter(source)
  assert.equal(parsed.meta.name, 'setup-device')
  assert.ok(parsed.meta.description)
  assert.deepEqual(parseFrontmatter(source.replaceAll('\n', '\r\n')), parsed)
})

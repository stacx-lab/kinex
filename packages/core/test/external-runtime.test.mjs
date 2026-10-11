import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createScope, inScope } from '../dist/scope.js'
import { spawnProcess } from '../dist/util/process.js'
import { parseFrontmatter } from '../dist/skill/index.js'

test('owned processes retain piped input and cancel independently of terminal input', async t => {
  const scope = createScope()
  const piped = inScope(scope, () => spawnProcess([process.execPath, '-e', 'process.stdin.pipe(process.stdout)']))
  t.after(() => piped.kill('SIGKILL'))
  piped.stdin.write('piped input')
  await piped.stdin.flush()
  piped.stdin.end()
  assert.equal(await new Response(piped.stdout).text(), 'piped input')
  assert.equal(await piped.exited, 0)
  const controller = new AbortController()
  const waiting = inScope(scope, () => spawnProcess([process.execPath, '-e', 'console.log("ready"); setInterval(() => {}, 1000)'],
    { stdin: 'inherit', signal: controller.signal, group: true }))
  t.after(() => waiting.kill('SIGKILL'))
  assert.ok(scope.processes.has(waiting))
  assert.match(new TextDecoder().decode((await waiting.stdout.getReader().read()).value), /ready/)
  controller.abort()
  assert.notEqual(await waiting.exited, 0)
  assert.equal(scope.processes.size, 0)
})

test('inherited stdin reaches the child without permitting programmatic writes', () => {
  const module = new URL('../dist/util/process.js', import.meta.url).href
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict'
    import { spawnProcess } from ${JSON.stringify(module)}
    const child = spawnProcess([process.execPath, '-e', 'process.stdin.pipe(process.stdout)'], { stdin: 'inherit' })
    assert.throws(() => child.stdin.write('unexpected'), /input belongs to the user/)
    child.stdin.end()
    process.stdout.write(await new Response(child.stdout).text())
    assert.equal(await child.exited, 0)
  `], { input: 'terminal input', encoding: 'utf8', timeout: 10000 })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, 'terminal input')
})

test('core skill frontmatter parses LF and Windows CRLF identically', async () => {
  const source = (await readFile(new URL('../assets/builtin/skill/setup-device/SKILL.md', import.meta.url), 'utf8')).replaceAll('\r\n', '\n')
  const parsed = parseFrontmatter(source)
  assert.equal(parsed.meta.name, 'setup-device')
  assert.ok(parsed.meta.description)
  assert.deepEqual(parseFrontmatter(source.replaceAll('\n', '\r\n')), parsed)
})

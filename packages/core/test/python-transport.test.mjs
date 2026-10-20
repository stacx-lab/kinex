import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const python = process.env.PYTHON ?? 'python3'
const library = fileURLToPath(new URL('../assets/python', import.meta.url))
function run(source, input, dialog = false) {
  const env = { ...process.env, PYTHONPATH: library }
  delete env.KINEX_TOOL_DIALOG
  if (dialog) env.KINEX_TOOL_DIALOG = '1'
  return spawnSync(python, ['-c', source], { input, env, encoding: 'utf8', timeout: 5000 })
}

test('tool startup rejects missing, malformed and non-object arguments', () => {
  for (const [input, error] of [
    ['', /missing tool startup request/],
    ['broken\n', /JSONDecodeError/],
    ['[]\n', /requires object args/],
    ['{"args":null}\n', /requires object args/],
  ]) {
    const result = run('import kinex', input, true)
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, error)
  }
  const inline = run('import runpy; runpy.run_module("kinex._inline", run_name="__main__")', '{"args":{}}\n', true)
  assert.equal(inline.status, 1, inline.stderr)
  assert.match(inline.stderr, /inline startup request requires source/)
})

test('ordinary Python imports leave stdin and stdout available to the caller', () => {
  const result = run('import kinex, kinex.runtime, sys\nprint(sys.stdin.readline().strip())', 'caller input\n')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, 'caller input\n')
  assert.equal(result.stderr, '')
})

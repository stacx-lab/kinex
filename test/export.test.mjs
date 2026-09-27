import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { isolate, workspace } from './helpers.mjs'

const isolation = await isolate()
after(isolation.cleanup)
const exec = promisify(execFile)
const entry = fileURLToPath(new URL('../bin/kinex.mjs', import.meta.url))
const invoke = (cwd, ...args) => exec(process.execPath, [entry, ...args], { cwd, env: process.env, timeout: 15000 })

for (const output of [undefined, 'custom export.html']) {
  test(`CLI exports a session to ${output ?? 'the default HTML path'} without starting a runtime`, async t => {
    const cwd = await workspace(t)
    const timestamp = new Date().toISOString()
    const session = [
      { type: 'session', version: 3, id: 'export-test', timestamp, cwd },
      { type: 'message', id: 'user-entry', parentId: null, timestamp,
        message: { role: 'user', content: 'Inspect the robot — 导出测试', timestamp: Date.now() } },
    ]
    const source = session.map(row => JSON.stringify(row)).join('\n') + '\n'
    await writeFile(path.join(cwd, 'session.jsonl'), source)
    const { stdout, stderr } = await invoke(cwd, '--export', 'session.jsonl', ...(output ? [output] : []))
    const exported = output ?? 'pi-session-session.html'
    assert.equal(stdout.trim(), `Exported to: ${exported}`)
    assert.equal(stderr, '')
    const html = await readFile(path.join(cwd, exported), 'utf8')
    const encoded = html.match(/<script id="session-data" type="application\/json">([\s\S]*?)<\/script>/)?.[1]
    assert.ok(encoded, 'export contains embedded session data')
    const data = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
    assert.equal(data.header.id, session[0].id)
    assert.equal(data.entries[0].message.content, session[1].message.content)
    assert.equal(data.leafId, 'user-entry')
    assert.equal(await readFile(path.join(cwd, 'session.jsonl'), 'utf8'), source)
    for (const directory of ['.kinex', '.pi']) await assert.rejects(stat(path.join(cwd, directory)), { code: 'ENOENT' })
  })
}

test('CLI export reports missing input files and invalid arguments', async t => {
  const cwd = await workspace(t)
  await assert.rejects(invoke(cwd, '--export', 'missing.jsonl'), error => {
    assert.equal(error.code, 1)
    assert.match(error.stderr, /File not found:/)
    return true
  })
  for (const args of [['--export'], ['--export', 'session.jsonl', 'one.html', 'two.html']]) {
    await assert.rejects(invoke(cwd, ...args), error => {
      assert.equal(error.code, 1)
      assert.match(error.stderr, /--export/)
      return true
    })
  }
  assert.match((await invoke(cwd, '--help')).stdout, /--export/)
})

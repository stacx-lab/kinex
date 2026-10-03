import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { isolate, fakeProvider, workspace, seed } from './helpers.mjs'
const exec = promisify(execFile)
const isolation = await isolate()
after(isolation.cleanup)
const { createKinexRuntime } = await import('@kinex/core')
const entry = fileURLToPath(new URL('../bin/kinex.mjs', import.meta.url))
const pty = fileURLToPath(new URL('./fixtures/tui_pty.py', import.meta.url))

test('real PTY renders Kinex, SDK tools/replies and device command completion', { timeout: 30000 }, async t => {
  const cwd = await workspace(t)
  const fake = await fakeProvider(t, isolation.root)
  fake.steps.push({ tool: 'write', args: { path: 'tui-result.txt', content: 'tui tool worked' } }, { text: 'KINEX_TUI_READY' })
  const runtime = createKinexRuntime({ directory: cwd })
  await seed(runtime)
  await runtime.dispose()
  const { stdout, stderr } = await exec('python3', [pty, process.execPath, entry, '--auto', '--model', 'fake/test', '--seed', 'TUI smoke'], {
    cwd, timeout: 25000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, TERM: 'xterm-256color', TUI_TEST_TRIGGER: 'KINEX_TUI_READY', TUI_TEST_KEYS: JSON.stringify([
      [0.05, '/load sen'], [0.05, '\t'], [0.05, '\r'], ['sensor loaded', '/devices\r'], [0.1, '/reload sensor\r'],
      ['sensor reloaded', '/unload sensor\r'], ['sensor unloaded', '/quit\r'],
    ]) },
  })
  assert.match(stdout, /Kinex/)
  assert.match(stdout, /sensor loaded/)
  assert.match(stdout, /sensor reloaded/)
  assert.match(stdout, /sensor unloaded/)
  assert.doesNotMatch(stdout + stderr, /TypeError|ReferenceError|Extension error|MODULE_NOT_FOUND/)
  assert.equal(fake.requests.length, 2)
  assert.equal(await readFile(path.join(cwd, 'tui-result.txt'), 'utf8'), 'tui tool worked')
  await assert.rejects(stat(path.join(cwd, '.pi')), { code: 'ENOENT' })
})

for (const tuiMode of ['regular', 'fullscreen']) test(`real PTY ${tuiMode} keeps recording on the directory row with expandable tools`, { timeout: 30000 }, async t => {
  const cwd = await workspace(t)
  const fake = await fakeProvider(t, isolation.root)
  const settingsFile = path.join(isolation.root, 'config', 'agent', 'settings.json')
  await writeFile(settingsFile, JSON.stringify({ ...JSON.parse(await readFile(settingsFile, 'utf8')), tuiMode }))
  fake.steps.push(
    { tool: 'device', args: { deviceID: 'sensor', action: 'read' } },
    { tool: 'record', args: { action: 'start', devices: { sensor: 2 }, instruction: 'PTY recording' } },
    { text: 'RECORDING_READY' },
  )
  const runtime = createKinexRuntime({ directory: cwd })
  await seed(runtime)
  await (await runtime.devices.load('sensor')).ready
  await runtime.dispose()
  const { stdout, stderr } = await exec('python3', [pty, process.execPath, entry, '--auto', '--enable-recording', '--model', 'fake/test', '--seed', 'Record the sensor'], {
    cwd, timeout: 25000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, TERM: 'xterm-256color', TUI_TEST_TRIGGER: 'RECORDING_READY', TUI_TEST_KEYS: JSON.stringify([
      [0.05, '\u000f'], [0.05, '\u000f'], [0.05, '/record stop success\r'], ['stopped', '/quit\r'],
    ]) },
  })
  const text = stripTerminalSequences(stdout)
  assert.match(text, /device read sensor/)
  assert.match(text, /record start sensor=2Hz/)
  assert.match(text, /rec: pty-recording/)
  assert.ok(text.split(/\r?\n/).some(line => line.includes(cwd) && line.includes('rec: pty-recording')), 'recording must share the directory line')
  assert.match(stdout, /\x1b\[31mrec: pty-recording/)
  // In fullscreen mode the first expanded tool can scroll out of the viewport.
  if (tuiMode === 'regular') assert.match(text, /"deviceID": "sensor"/)
  assert.doesNotMatch(text + stderr, /TypeError|ReferenceError|Extension error/)
  assert.equal(fake.requests.length, 3)
  const saved = createKinexRuntime({ directory: cwd })
  try {
    const recent = await saved.recording.recent()
    assert.equal(recent[0].status, 'stopped')
    assert.equal(recent[0].outcome, 'success')
  } finally { await saved.dispose() }
})

test('real PTY permission dialog approves a coding tool through the keyboard', { timeout: 30000 }, async t => {
  const cwd = await workspace(t)
  const fake = await fakeProvider(t, isolation.root)
  fake.steps.push({ tool: 'write', args: { path: 'approved.txt', content: 'approved' } }, { text: 'APPROVAL_DONE' })
  const { stdout, stderr } = await exec('python3', [pty, process.execPath, entry, '--model', 'fake/test', '--seed', 'Ask permission'], {
    cwd, timeout: 25000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, TERM: 'xterm-256color', TUI_TEST_TRIGGER: 'Allow once', TUI_TEST_KEYS: JSON.stringify([[0.05, '\r'], ['APPROVAL_DONE', '/quit\r']]) },
  })
  assert.match(stdout, /APPROVAL_DONE/)
  assert.doesNotMatch(stdout + stderr, /Extension error|TypeError/)
  assert.equal(await readFile(path.join(cwd, 'approved.txt'), 'utf8'), 'approved')
})

test('real PTY keeps interviews enabled in auto mode', { timeout: 30000 }, async t => {
  const cwd = await workspace(t)
  const fake = await fakeProvider(t, isolation.root)
  fake.steps.push({ tool: 'question', args: { questions: [{ header: 'Camera', question: 'Which camera should be used?', options: [{ label: 'Left camera' }, { label: 'Right camera' }] }] } }, { text: 'INTERVIEW_DONE' })
  const { stdout } = await exec('python3', [pty, process.execPath, entry, '--auto', '--model', 'fake/test', '--seed', 'Ask a question'], {
    cwd, timeout: 25000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, TERM: 'xterm-256color', TUI_TEST_TRIGGER: 'Left camera', TUI_TEST_KEYS: JSON.stringify([[0.05, '\r'], ['INTERVIEW_DONE', '/quit\r']]) },
  })
  assert.match(stdout, /INTERVIEW_DONE/)
  assert.match(JSON.stringify(fake.requests[1].messages), /Left camera/)
})

test('real PTY Escape cancels a permission dialog without executing the write', { timeout: 30000 }, async t => {
  const cwd = await workspace(t)
  const fake = await fakeProvider(t, isolation.root)
  fake.steps.push({ tool: 'write', args: { path: 'denied.txt', content: 'must not exist' } })
  await exec('python3', [pty, process.execPath, entry, '--model', 'fake/test', '--seed', 'Ask permission'], {
    cwd, timeout: 25000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, TERM: 'xterm-256color', TUI_TEST_TRIGGER: 'Allow once', TUI_TEST_KEYS: JSON.stringify([[0.05, '\u001b'], [0.1, '/quit\r']]) },
  })
  await assert.rejects(stat(path.join(cwd, 'denied.txt')), { code: 'ENOENT' })
  assert.equal(fake.requests.length, 1)
})

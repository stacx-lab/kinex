import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { isolate, fakeProvider, workspace, seed } from './helpers.mjs'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { sessionDirectory } from '../dist/settings.js'
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
  const { stdout, stderr } = await exec('python3', [pty, process.execPath, entry, '--auto', '--model', 'fake/test', 'TUI smoke'], {
    cwd, timeout: 25000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, TERM: 'xterm-256color', TUI_TEST_TRIGGER: 'KINEX_TUI_READY', TUI_TEST_KEYS: JSON.stringify([
      [0.05, '/load sen'], [0.05, '\t'], [0.05, '\r'], ['sensor loaded', '/devices\r'], [0.1, '/reload\r'],
      ['Reloaded keybindings', '/unload sensor\r'], ['sensor unloaded', '/quit\r'],
    ]) },
  })
  assert.match(stdout, /Kinex/)
  assert.match(stripTerminalSequences(stdout), /time \d+s/)
  assert.match(stdout, /sensor loaded/)
  assert.match(stdout, /Reloaded keybindings/)
  assert.doesNotMatch(stdout, /sensor reloaded/)
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
  const { stdout, stderr } = await exec('python3', [pty, process.execPath, entry, '--auto', '--enable-recording', '--model', 'fake/test', 'Record the sensor'], {
    cwd, timeout: 25000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, TERM: 'xterm-256color', TUI_TEST_TRIGGER: 'RECORDING_READY', TUI_TEST_KEYS: JSON.stringify([
      [0.05, '\u000f'], [0.05, '\u000f'], [0.05, '/record stop success\r'], ['stopped', '/quit\r'],
    ]) },
  })
  const text = stripTerminalSequences(stdout)
  assert.match(text, /device read sensor/)
  assert.match(text, /record start sensor=2Hz/)
  assert.match(text, /rec: pty-recording/)
  assert.ok(text.split(/\r?\n/).some(line => /time \d+s/.test(line) && line.includes('CH')), 'time must share the usage stats line')
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
  const { stdout, stderr } = await exec('python3', [pty, process.execPath, entry, '--model', 'fake/test', 'Ask permission'], {
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
  const { stdout } = await exec('python3', [pty, process.execPath, entry, '--auto', '--model', 'fake/test', 'Ask a question'], {
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
  await exec('python3', [pty, process.execPath, entry, '--model', 'fake/test', 'Ask permission'], {
    cwd, timeout: 25000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, TERM: 'xterm-256color', TUI_TEST_TRIGGER: 'Allow once', TUI_TEST_KEYS: JSON.stringify([[0.05, '\u001b'], [0.1, '/quit\r']]) },
  })
  await assert.rejects(stat(path.join(cwd, 'denied.txt')), { code: 'ENOENT' })
  assert.equal(fake.requests.length, 1)
})

test('exit hint reopens the same session from another directory with quoted storage paths', { timeout: 30000 }, async t => {
  const cwd = await workspace(t), elsewhere = await workspace(t)
  const fake = await fakeProvider(t, isolation.root)
  fake.steps.push({ text: 'RESUME_HINT_READY' })
  const config = path.join(cwd, 'isolated config')
  await mkdir(path.join(config, 'agent'), { recursive: true })
  for (const name of ['models.json', 'settings.json']) {
    await writeFile(path.join(config, 'agent', name), await readFile(path.join(isolation.root, 'config/agent', name)))
  }
  const env = { ...process.env, TERM: 'xterm-256color', KINEX_CONFIG_DIR: config, KINEX_DATA_DIR: path.join(cwd, "state with 'quotes'"),
    TUI_TEST_TRIGGER: 'RESUME_HINT_READY', TUI_TEST_KEYS: JSON.stringify([[0.05, '/quit\r']]) }
  const first = await exec('python3', [pty, process.execPath, entry, '--model', 'fake/test', 'remember HINT_HISTORY'], {
    cwd, env, timeout: 25000, maxBuffer: 8 * 1024 * 1024,
  })
  const hint = stripTerminalSequences(first.stdout).match(/To resume this session: (kinex [^\r\n]+)/)?.[1]
  assert.ok(hint, first.stdout + first.stderr)
  assert.doesNotMatch(hint, /--session-dir/)
  // Execute the exact shell-quoted command, resolving kinex to this checkout's launcher.
  const resumed = exec('bash', ['-c', `kinex() { "$KINEX_TEST_NODE" "$KINEX_TEST_ENTRY" "$@"; }\n${hint} -p 'recall the marker'`], {
    cwd: elsewhere, env: { ...env, KINEX_TEST_NODE: process.execPath, KINEX_TEST_ENTRY: entry }, timeout: 20000,
  })
  resumed.child.stdin.end()
  assert.match((await resumed).stdout, /FAKE_REPLY_OK/)
  assert.equal(fake.requests.length, 2)
  assert.match(JSON.stringify(fake.requests[1].messages), /HINT_HISTORY/)
})

test('resume picker selects the existing session and sends the positional prompt', { timeout: 30000 }, async t => {
  const cwd = await workspace(t)
  const fake = await fakeProvider(t, isolation.root)
  const initial = exec(process.execPath, [entry, '-p', 'remember PICKER_HISTORY'], { cwd, env: process.env, timeout: 20000 })
  initial.child.stdin.end()
  await initial
  fake.steps.push({ text: 'PICKER_RESUMED' })
  const [before] = await SessionManager.list(cwd, sessionDirectory(cwd))
  const { stdout, stderr } = await exec('python3', [pty, process.execPath, entry, '-r', 'continue that conversation'], {
    cwd, timeout: 25000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, TERM: 'xterm-256color', TUI_TEST_TRIGGER: 'PICKER_HISTORY',
      TUI_TEST_KEYS: JSON.stringify([[0.15, '\r'], ['PICKER_RESUMED', '/quit\r']]) },
  })
  assert.match(stripTerminalSequences(stdout), /Resume Session/)
  assert.match(stripTerminalSequences(stdout), /To resume this session: kinex --session/)
  assert.equal(stderr, '')
  assert.equal(fake.requests.length, 2)
  assert.match(JSON.stringify(fake.requests[1].messages), /PICKER_HISTORY/)
  const [after] = await SessionManager.list(cwd, sessionDirectory(cwd))
  assert.equal(after.id, before.id)
})

test('resume picker cancellation creates no robotics workspace or session', { timeout: 30000 }, async t => {
  const cwd = await workspace(t)
  const fake = await fakeProvider(t, isolation.root)
  const { stdout, stderr } = await exec('python3', [pty, process.execPath, entry, '--resume'], {
    cwd, timeout: 25000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, TERM: 'xterm-256color', TUI_TEST_TRIGGER: 'No sessions in current folder',
      TUI_TEST_KEYS: JSON.stringify([[0.05, '\u001b']]) },
  })
  assert.match(stdout, /No session selected/)
  assert.equal(stderr, '')
  assert.equal(fake.requests.length, 0)
  await assert.rejects(stat(sessionDirectory(cwd)), { code: 'ENOENT' })
  await assert.rejects(stat(path.join(cwd, '.kinex')), { code: 'ENOENT' })
})

test('exit hint follows a session switched inside the TUI', { timeout: 30000 }, async t => {
  const cwd = await workspace(t)
  const fake = await fakeProvider(t, isolation.root)
  const { createApplication } = await import('../dist/application.js')
  const target = await createApplication({ cwd, model: 'fake/test' })
  await target.host.session.bindExtensions({ mode: 'print' })
  await target.host.session.prompt('SWITCH_TARGET_HISTORY')
  const file = target.host.session.sessionFile
  await target.dispose()
  fake.steps.push({ text: 'SWITCH_READY' })
  const { stdout } = await exec('python3', [pty, process.execPath, entry, '--model', 'fake/test', 'start another session'], {
    cwd, timeout: 25000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, TERM: 'xterm-256color', TUI_TEST_TRIGGER: 'SWITCH_READY',
      TUI_TEST_KEYS: JSON.stringify([[0.1, '/resume\r'], ['Resume Session', 'SWITCH_TARGET_HISTORY'], [0.2, '\r'], [0.5, '/quit\r']]) },
  })
  assert.ok(stripTerminalSequences(stdout).includes(`To resume this session: kinex --session '${file}'`))
})

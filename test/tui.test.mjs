import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { readFile, stat, writeFile, mkdir, chmod } from 'node:fs/promises'
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

async function aptCommands(cwd, authenticationPrelude = '') {
  const commands = path.join(cwd, 'commands')
  await mkdir(commands)
  const scripts = {
    dpkg: "print('amd64')",
    'dpkg-query': "from pathlib import Path\nimport sys\nsys.exit(1) if not Path('installed').exists() else print('installed\\tok\\t1\\tamd64')",
    'apt-get': "from pathlib import Path\nimport sys\nassert sys.stdin.read() == ''\nprint('APT_INSTALL_PROGRESS')\nif 'install' in sys.argv: Path('installed').write_text('yes')",
    sudo: `import getpass, os, sys
from pathlib import Path
identity = f'{os.getppid()}:{os.getsid(0)}:{any(os.isatty(fd) for fd in range(3))}'
if '-S' in sys.argv:
${authenticationPrelude}
    password = getpass.getpass('KINEX_PASSWORD: ', stream=sys.stderr)
    if password != 'fixture-password': sys.exit(1)
    Path('authenticated').write_text(identity)
    sys.exit(0)
if not Path('authenticated').exists() or Path('authenticated').read_text() != identity:
    print('sudo: a password is required', file=sys.stderr)
    sys.exit(1)
args = sys.argv[2:]
if args[0].startswith('DEBIAN_FRONTEND='): args = args[1:]
os.execvp(args[0], args)
`,
  }
  for (const [name, source] of Object.entries(scripts)) {
    const file = path.join(commands, name)
    await writeFile(file, '#!/usr/bin/python3\n' + source + '\n')
    await chmod(file, 0o755)
  }
  return commands
}

test('apt onboarding authenticates in the terminal and keeps passwords out of model history', {
  timeout: 30000, skip: process.platform !== 'linux' || process.getuid?.() === 0,
}, async t => {
  const cwd = await workspace(t)
  const commands = await aptCommands(cwd)
  const fake = await fakeProvider(t, isolation.root)
  fake.steps.push({ tool: 'kinex_install_apt', args: { packages: ['kinex-test'] } }, { text: 'APT_ONBOARDING_DONE' })
  const { stdout, stderr } = await exec('python3', [pty, process.execPath, entry, '--auto', '--model', 'fake/test', '--seed', 'Install required packages'], {
    cwd, timeout: 25000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, PATH: `${commands}:${process.env.PATH}`, TERM: 'xterm-256color', TUI_TEST_TRIGGER: 'KINEX_PASSWORD:',
      TUI_TEST_KEYS: JSON.stringify([[0.1, 'fixture-password\r'], ['APT_ONBOARDING_DONE', '/quit\r']]) },
  })
  assert.match(stdout, /APT_ONBOARDING_DONE/)
  assert.match(stdout, /APT_INSTALL_PROGRESS/)
  assert.doesNotMatch(stdout + stderr, /fixture-password|Extension error|TypeError/)
  assert.equal(await readFile(path.join(cwd, 'installed'), 'utf8'), 'yes')
  assert.equal(fake.requests.length, 2)
  const transcript = JSON.stringify(fake.requests[1].messages)
  assert.doesNotMatch(transcript, /fixture-password|KINEX_PASSWORD|APT_INSTALL_PROGRESS/)
  assert.match(transcript, /\\?"status\\?": ?\\?"ok/)
  await assert.rejects(stat(path.join(cwd, '.kinex/python')), { code: 'ENOENT' })
})

test('Ctrl+C at sudo cancels installation and leaves the session responsive', {
  timeout: 30000, skip: process.platform !== 'linux' || process.getuid?.() === 0,
}, async t => {
  const cwd = await workspace(t)
  const commands = await aptCommands(cwd, `    import subprocess
    subprocess.Popen([sys.executable, '-c', "import time; from pathlib import Path; time.sleep(2); Path('orphan').write_text('bad')"])
`)
  const fake = await fakeProvider(t, isolation.root)
  fake.steps.push(
    { tool: 'kinex_install_apt', args: { packages: ['kinex-test'] } },
    { text: 'APT_AUTH_CANCELLED' },
    { tool: 'write', args: { path: 'responsive.txt', content: 'session continued' } },
    { text: 'APT_SESSION_RESPONSIVE' },
  )
  const { stdout, stderr } = await exec('python3', [pty, process.execPath, entry, '--auto', '--model', 'fake/test', '--seed', 'Install required packages'], {
    cwd, timeout: 25000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, PATH: `${commands}:${process.env.PATH}`, TERM: 'xterm-256color', TUI_TEST_TRIGGER: 'KINEX_PASSWORD:',
      TUI_TEST_KEYS: JSON.stringify([[0.1, '\u0003'], ['APT_AUTH_CANCELLED', 'Continue after cancellation\r'], ['APT_SESSION_RESPONSIVE', '/quit\r']]) },
  })
  assert.match(stdout, /APT_SESSION_RESPONSIVE/)
  assert.doesNotMatch(stdout + stderr, /Extension error|TypeError/)
  assert.equal(fake.requests.length, 4)
  assert.match(JSON.stringify(fake.requests[1].messages), /installation cancelled; packages remain incomplete/)
  assert.equal(await readFile(path.join(cwd, 'responsive.txt'), 'utf8'), 'session continued')
  await assert.rejects(stat(path.join(cwd, 'installed')), { code: 'ENOENT' })
  await delay(2100)
  await assert.rejects(stat(path.join(cwd, 'orphan')), { code: 'ENOENT' })
})

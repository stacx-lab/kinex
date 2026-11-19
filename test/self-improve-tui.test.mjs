import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { isolate, fakeProvider, workspace } from './helpers.mjs'

const exec = promisify(execFile)
const isolation = await isolate()
after(isolation.cleanup)
const entry = fileURLToPath(new URL('../bin/kinex.mjs', import.meta.url))
const pty = fileURLToPath(new URL('./fixtures/tui_pty.py', import.meta.url))
const rosbridge = fileURLToPath(new URL('./fixtures/rosbridge.mjs', import.meta.url))
const sandbox = await exec('bwrap', ['--unshare-all', '--share-net', '--ro-bind', '/', '/', 'true']).then(() => true, () => false)
if (!sandbox) process.env.KINEX_SELF_IMPROVE_SANDBOX = 'off'

const said = request => JSON.stringify(request.messages.filter(message => message.role === 'user'))
async function terminal(t, name, keys, timeout) {
  const state = path.join(isolation.root, name)
  await mkdir(state)
  const { stdout, stderr } = await exec('python3', [pty, process.execPath, entry, '--auto', '--model', 'fake/test', 'TUI smoke'], {
    cwd: await workspace(t), timeout: (timeout + 10) * 1000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, TERM: 'xterm-256color', KINEX_ROSBRIDGE: rosbridge, FAKE_ROSBRIDGE_STATE: state,
      TUI_TEST_TIMEOUT: String(timeout), TUI_TEST_TRIGGER: 'KINEX_TUI_READY', TUI_TEST_KEYS: JSON.stringify(keys) },
  })
  assert.doesNotMatch(stdout + stderr, /TypeError|ReferenceError|Extension error|MODULE_NOT_FOUND|stale after session replacement/)
  // The terminal wraps long lines, so what it showed is compared with its whitespace collapsed.
  return { text: stripTerminalSequences(stdout).replaceAll(/\s+/g, ' '), state }
}

test('in the terminal a run returns at once, distills in a session of its own and gives the conversation back', { timeout: 150000 }, async t => {
  const fake = await fakeProvider(t, isolation.root)
  fake.respond = request => {
    const text = said(request)
    const step = request.messages.filter(message => message.role === 'tool').length
    if (text.includes('Work only in this directory')) return { text: 'I could not press it.' }
    if (text.includes('You turn the records of earlier trials')) return [{ tool: 'improve_check', args: {} }, { text: 'DISTILLER_SPOKE' }][step]
    return { text: text.includes('hello again') ? 'HOME_AGAIN_OK' : 'KINEX_TUI_READY' }
  }
  const { text } = await terminal(t, 'rosbridge-tui', [
    // Keys wait for single words: a phrase may be broken across two lines of the terminal.
    [0.2, '/self-improve sim/press-button\r'], ['Install', 'hello again\r'], ['HOME_AGAIN_OK', '/quit\r'],
  ], 120)
  assert.match(text, /Trials run in the background/)
  assert.match(text, /has ended: its rounds are done/)
  assert.match(text, /DISTILLER_SPOKE/, 'the distillation shows in the terminal')
  assert.match(text, /d001, base L0, 1 trials \(1 new\), published L1/)
  const home = fake.requests.at(-1)
  assert.match(said(home), /TUI smoke.*hello again/, 'the conversation is the user\'s own again')
  assert.doesNotMatch(said(home), /You turn the records of earlier trials/)
  assert.match(JSON.stringify(home.messages), /has ended: its rounds are done/, 'and it was told how the run ended')
})

test('in the terminal /self-improve stop ends a run and its trials', { timeout: 90000 }, async t => {
  const fake = await fakeProvider(t, isolation.root)
  fake.respond = request => said(request).includes('Work only in this directory') ? { wait: new Promise(() => {}) } : { text: 'KINEX_TUI_READY' }
  const { text, state } = await terminal(t, 'rosbridge-tui-stop', [
    [0.2, '/self-improve sim/press-button\r'], ['Scheduling', '/self-improve sim/open-door\r'],
    [8, '/self-improve status\r'], ['running', '/self-improve stop\r'], ['abandoned', '/self-improve status\r'], ['UNSOLVED', '/quit\r'],
  ], 70)
  assert.match(text, /t001, sim\/press-button, L0, running/, 'the session is free while trials run')
  assert.match(text, /is already scheduled in this Kinex/)
  assert.match(text, /Stopping the self-improve run/)
  assert.match(text, /was stopped: its running trials were ended/)
  assert.match(text, /t001, sim\/press-button, L0, abandoned/)
  const runs = path.join(process.env.KINEX_DATA_DIR, 'self-improve')
  const name = (await readdir(runs)).filter(entry => !entry.startsWith('.')).at(-1)
  await assert.rejects(readFile(path.join(runs, name, 'trials/t001/record/result.json')), { code: 'ENOENT' })
  assert.ok((await readFile(path.join(state, 'calls.log'), 'utf8')).split('\n').some(line => line.startsWith('stop run1')), 'its simulator was stopped')
})

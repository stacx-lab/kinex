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
process.env.PI_SUBAGENTS_TEMP_ROOT = path.join(isolation.root, 'subagents')
const { sandboxOf } = await import('@kinex/self-improve/sandbox')
if (!await sandboxOf(true).then(() => true, () => false)) process.env.KINEX_SELF_IMPROVE_SANDBOX = 'off'

const said = request => JSON.stringify(request.messages)
const last = request => { const message = request.messages.at(-1); return typeof message.content === 'string' ? message.content : JSON.stringify(message.content) }
async function terminal(t, name, mode, keys, timeout) {
  const state = path.join(isolation.root, name)
  await mkdir(state)
  const { stdout, stderr } = await exec('python3', [pty, process.execPath, entry, ...mode, '--model', 'fake/test', 'TUI smoke'], {
    cwd: await workspace(t), timeout: (timeout + 10) * 1000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, TERM: 'xterm-256color', KINEX_ROSBRIDGE: rosbridge, FAKE_ROSBRIDGE_STATE: state,
      TUI_TEST_TIMEOUT: String(timeout), TUI_TEST_TRIGGER: 'KINEX_TUI_READY', TUI_TEST_KEYS: JSON.stringify(keys) },
  })
  assert.doesNotMatch(stdout + stderr, /TypeError|ReferenceError|Extension error|MODULE_NOT_FOUND|stale after session replacement/)
  // The terminal wraps long lines, so what it showed is compared with its whitespace collapsed.
  return { text: stripTerminalSequences(stdout).replaceAll(/\s+/g, ' '), state }
}

// The user's session, scripted: it plans the press task, and then does what improve_next says.
function session(request) {
  const text = last(request)
  const has = name => request.tools.some(tool => tool.function.name === name)
  if (request.messages.at(-1).role !== 'tool') {
    if (text.includes('hello again')) return { text: 'HOME_AGAIN_OK' }
    if (text.includes('pi_subagents_notice')) return has('improve_next') ? { tool: 'improve_next', args: {} } : { text: 'RUN_OVER' }
    return has('improve_tasks') ? { tool: 'improve_tasks', args: { pattern: 'sim/press-button' } } : { text: 'KINEX_TUI_READY' }
  }
  if (/^sim\/[^\n]* \(robot /.test(text)) return { tool: 'improve_plan', args: { tasks: ['sim/press-button'] } }
  const starts = [...text.matchAll(/subagent\(\{ agent: "([^"]+)", task: "([^"]+)" \}\)/g)]
  if (starts.length) return { tools: starts.map(([, agent, task]) => ({ name: 'subagent', args: { agent, task } })) }
  return { text: /has ended|stopped on an error/.test(text) ? 'RUN_OVER' : 'TRIALS_STARTED' }
}

test('in the terminal the user approves the plan, which moves Kinex to auto mode, and the run goes on in the background of their conversation', { timeout: 200000 }, async t => {
  const fake = await fakeProvider(t, isolation.root)
  fake.respond = request => {
    const text = said(request)
    const step = request.messages.filter(message => message.role === 'tool').length
    if (text.includes('Work only in this directory')) return { text: 'I could not press it.' }
    if (text.includes('You turn the records of earlier trials')) return [{ tool: 'improve_check', args: {} }, { text: 'DISTILLER_SPOKE' }][Math.min(step, 1)]
    return session(request)
  }
  // Started in ask mode. Keys wait for single words: a phrase may be broken across two lines of the terminal.
  const { text } = await terminal(t, 'rosbridge-tui', [], [
    [0.2, '/self-improve the press task\r'], ['Approve', '\r'], ['RUN_OVER', 'hello again\r'], ['HOME_AGAIN_OK', '/quit\r'],
  ], 170)
  assert.match(text, /Approve and switch Kinex to auto mode\?/)
  assert.match(text, /Self-improve plan: 1 task of rosbridge's catalog on robot sim\/arm: sim\/press-button/)
  assert.match(text, /devices · auto/, 'the session works without approvals from then on')
  assert.match(text, /TRIALS_STARTED/, 'the turn that started the trial ended')
  const home = fake.requests.at(-1)
  assert.match(said(home), /TUI smoke[^]*The user asks for a self-improve run[^]*pi_subagents_notice[^]*hello again/, 'the run went on in the user\'s own conversation')
  assert.match(said(home), /t001, sim\/press-button, L0, failure/)
  assert.match(said(home), /d001, base L0, 1 trials \(1 new\), published L1/)
  assert.match(said(home), /has ended: its rounds are done/)
  assert.doesNotMatch(said(home), /You turn the records of earlier trials|DISTILLER_SPOKE/, 'the distillation was a session of its own')
})

test('in the terminal /self-improve stop ends a run and its trials', { timeout: 120000 }, async t => {
  const fake = await fakeProvider(t, isolation.root)
  fake.respond = request => said(request).includes('Work only in this directory') ? { wait: new Promise(() => {}) } : session(request)
  const { text, state } = await terminal(t, 'rosbridge-tui-stop', ['--auto'], [
    [0.2, '/self-improve the press task\r'], ['Approve', '\r'], ['TRIALS_STARTED', '/self-improve another run\r'],
    // The stopped trial closes its simulator before it is gone, so the last status waits a moment.
    [8, '/self-improve status\r'], ['running', '/self-improve stop\r'], [6, '/self-improve status\r'], ['abandoned', '/quit\r'],
  ], 90)
  assert.match(text, /Approve\?/, 'a session in auto mode is asked too')
  assert.match(text, /t001, sim\/press-button, L0, running/, 'the session is free while trials run')
  assert.match(text, /is already scheduled in this Kinex/)
  assert.match(text, /Stopped the self-improve run [^ ]+: t001 ended and count as abandoned/)
  assert.match(text, /t001, sim\/press-button, L0, abandoned/)
  const runs = path.join(process.env.KINEX_DATA_DIR, 'self-improve')
  const name = (await readdir(runs)).filter(entry => !entry.startsWith('.')).at(-1)
  await assert.rejects(readFile(path.join(runs, name, 'trials/t001/record/result.json')), { code: 'ENOENT' })
  assert.ok((await readFile(path.join(state, 'calls.log'), 'utf8')).split('\n').some(line => line.startsWith('stop run1')), 'its simulator was stopped')
})

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { isolate, fakeProvider, sandboxOrStandIn, workspace } from './helpers.mjs'

const exec = promisify(execFile)
const isolation = await isolate()
after(isolation.cleanup)
const entry = fileURLToPath(new URL('../bin/kinex.mjs', import.meta.url))
const pty = fileURLToPath(new URL('./fixtures/tui_pty.py', import.meta.url))
const kinexSim = fileURLToPath(new URL('./fixtures/kinex-sim.mjs', import.meta.url))
process.env.PI_SUBAGENTS_TEMP_ROOT = path.join(isolation.root, 'subagents')
await sandboxOrStandIn()

const said = request => JSON.stringify(request.messages)
// What the session was last given, past the context updates Kinex adds when the workspace changes, as approving a plan makes its Kinex folder.
const latest = request => request.messages.findLast(message => !JSON.stringify(message.content ?? '').includes('<kinex_context>'))
const last = request => { const message = latest(request); return typeof message.content === 'string' ? message.content : JSON.stringify(message.content) }
async function terminal(t, name, mode, keys, timeout) {
  const state = path.join(isolation.root, name)
  await mkdir(state)
  const cwd = await workspace(t)
  const { stdout, stderr } = await exec('python3', [pty, process.execPath, entry, ...mode, '--model', 'fake/test', 'TUI smoke'], {
    cwd, timeout: (timeout + 10) * 1000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, TERM: 'xterm-256color', FAKE_KINEX_SIM_STATE: state,
      TUI_TEST_TIMEOUT: String(timeout), TUI_TEST_TRIGGER: 'KINEX_TUI_READY', TUI_TEST_KEYS: JSON.stringify(keys) },
  })
  assert.doesNotMatch(stdout + stderr, /TypeError|ReferenceError|Extension error|MODULE_NOT_FOUND|stale after session replacement/)
  // The terminal wraps long lines, so what it showed is compared with its whitespace collapsed.
  return { text: stripTerminalSequences(stdout).replaceAll(/\s+/g, ' '), state, cwd }
}

// The user's session, scripted: it plans the press task, and then does what skill_next says.
function session(request) {
  const text = last(request)
  const has = name => request.tools.some(tool => tool.function.name === name)
  if (latest(request).role !== 'tool') {
    if (text.includes('hello again')) return { text: 'HOME_AGAIN_OK' }
    if (text.includes('pi_subagents_notice')) return has('skill_next') ? { tool: 'skill_next', args: {} } : { text: 'RUN_OVER' }
    return has('skill_plan') ? { tool: 'skill_plan', args: { tasks: ['sim/press-button'], command: kinexSim } } : { text: 'KINEX_TUI_READY' }
  }
  // The calls skill_next gives are made as they are written: a wave's workflow, or the distillation.
  const waves = [...text.matchAll(/subagent\(\{ workflow: ("[^"]+"), args: \{ run: ("[^"]+"), library: ("[^"]+"), tasks: (\[[^\]]*\]) \}, globalConcurrencyLimit: (\d+), async: true \}\)/g)]
    .map(([, workflow, run, library, tasks, limit]) => ({ workflow: JSON.parse(workflow), args: { run: JSON.parse(run), library: JSON.parse(library), tasks: JSON.parse(tasks) }, globalConcurrencyLimit: Number(limit), async: true }))
  const starts = [...waves, ...[...text.matchAll(/subagent\(\{ agent: "([^"]+)", task: "([^"]+)" \}\)/g)].map(([, agent, task]) => ({ agent, task }))]
  if (starts.length) return { tools: starts.map(args => ({ name: 'subagent', args })) }
  return { text: /has ended|stopped on an error/.test(text) ? 'RUN_OVER' : 'TRIALS_STARTED' }
}

test('in the terminal the user approves the plan, which moves Kinex to auto mode, and the run goes on in the background of their conversation', { timeout: 200000 }, async t => {
  const fake = await fakeProvider(t, isolation.root)
  fake.respond = request => {
    const text = said(request)
    const step = request.messages.filter(message => message.role === 'tool').length
    if (text.includes('Work only in this directory')) return { text: 'I could not press it.' }
    if (text.includes('You turn the records of earlier trials')) return [{ tool: 'skill_check', args: {} }, { text: 'DISTILLER_SPOKE' }][Math.min(step, 1)]
    return session(request)
  }
  // Started in ask mode. Keys wait for single words: a phrase may be broken across two lines of the terminal.
  const { text } = await terminal(t, 'kinex-sim-tui', [], [
    [0.2, '/code-as-skill the press task\r'], ['Approve', '\r'], ['RUN_OVER', 'hello again\r'], ['HOME_AGAIN_OK', '/quit\r'],
  ], 170)
  assert.match(text, /Approve and switch Kinex to auto mode\?/)
  assert.match(text, /code-as-skill plan: 1 task on robot sim\/arm sim\/press-button 1 round, 1 trial at a time/)
  assert.match(text, /devices · auto/, 'the session works without approvals from then on')
  assert.match(text, /TRIALS_STARTED/, 'the turn that started the trial ended')
  const home = fake.requests.at(-1)
  assert.match(said(home), /TUI smoke[^]*The user asks for a code-as-skill run[^]*pi_subagents_notice[^]*hello again/, 'the run went on in the user\'s own conversation')
  assert.match(said(home), /t001, sim\/press-button, L0, failure/)
  assert.match(said(home), /d001, base L0, 1 trials \(1 new\), published L1/)
  assert.match(said(home), /has ended: its rounds are done/)
  assert.doesNotMatch(said(home), /You turn the records of earlier trials|DISTILLER_SPOKE/, 'the distillation was a session of its own')
})

test('in the terminal /code-as-skill stop ends a run and its trials', { timeout: 120000 }, async t => {
  const fake = await fakeProvider(t, isolation.root)
  fake.respond = request => said(request).includes('Work only in this directory') ? { wait: new Promise(() => {}) } : session(request)
  const { text, state, cwd } = await terminal(t, 'kinex-sim-tui-stop', ['--auto'], [
    [0.2, '/code-as-skill the press task\r'], ['Approve', '\r'], ['TRIALS_STARTED', '/code-as-skill another run\r'],
    // The stopped trial closes its simulator before it is gone, so the last status waits a moment.
    [8, '/code-as-skill status\r'], ['running', '/code-as-skill stop\r'], [6, '/code-as-skill status\r'], ['abandoned', '/quit\r'],
  ], 90)
  assert.match(text, /Approve\?/, 'a session in auto mode is asked too')
  assert.match(text, /t001, sim\/press-button, L0, running/, 'the session is free while trials run')
  assert.match(text, /is already scheduled in this Kinex/)
  assert.match(text, /Stopped the code-as-skill run [^ ]+: t001 ended and count as abandoned/)
  assert.match(text, /t001, sim\/press-button, L0, abandoned/)
  const runs = path.join(cwd, '.kinex/self-improve/code-as-skill/runs')
  const name = (await readdir(runs)).filter(entry => !entry.startsWith('.')).at(-1)
  await assert.rejects(readFile(path.join(runs, name, 'trials/t001/record/result.json')), { code: 'ENOENT' })
  assert.ok((await readFile(path.join(state, 'calls.log'), 'utf8')).split('\n').some(line => line.startsWith('stop run1')), 'its simulator was stopped')
})

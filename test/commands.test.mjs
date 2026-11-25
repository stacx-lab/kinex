import { test } from 'node:test'
import assert from 'node:assert/strict'
import { commandProgress, executeCommand } from '../dist/integration/commands.js'

// Pi rejects every use of a ctx once the session that issued it is replaced.
function progressContext(live, widgets) {
  const used = () => assert.ok(live.value, 'replaced session')
  return { get hasUI() { used(); return true }, signal: undefined, abort() {}, sessionManager: { getSessionId: () => 'session' }, ui: {
    setWidget: (...args) => { used(); widgets.push(args[0]) },
    notify: message => { used(); widgets.push(message) },
    confirm: async () => { used(); return true },
    onTerminalInput: () => () => {},
  } }
}
// The UI of a ctx's session while it lasts, as the extension gives it to what may outlive the session.
const sessionUI = live => ctx => live.value && ctx.hasUI ? ctx.ui : undefined

test('a command row appears once a command lasts and goes when it ends', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const widgets = []
  const progress = commandProgress(progressContext({ value: true }, widgets), 'devices', 'load sensor', sessionUI({ value: true }))
  t.mock.timers.tick(100)
  assert.deepEqual(widgets, [])
  t.mock.timers.tick(50)
  progress.end()
  assert.deepEqual(widgets, ['kinex-command', 'kinex-command'])
})

test('a command row never touches the ctx of a session that was replaced meanwhile', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const widgets = []
  const live = { value: true }
  const progress = commandProgress(progressContext(live, widgets), 'devices', 'load sensor', sessionUI(live))
  live.value = false // The session was replaced while the command kept running in the shared runtime.
  t.mock.timers.tick(200)
  progress.end()
  assert.deepEqual(widgets, [])
})

test('a command that reports or asks after its session was replaced goes on, unanswered', async () => {
  const shown = []
  const live = { value: true }
  const command = { name: 'load', execute: async (_args, context) => {
    context.notify('activating')
    const before = await context.confirm('Unregister?', '')
    live.value = false // The session was replaced while the command kept running in the shared runtime.
    context.notify('ready')
    return { kind: 'text', text: `${before} ${await context.confirm('Unregister?', '')}` }
  } }
  const result = await executeCommand(command, '', progressContext(live, shown), sessionUI(live))
  assert.deepEqual([result.text, shown], ['true false', ['activating']])
})

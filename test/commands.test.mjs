import { test } from 'node:test'
import assert from 'node:assert/strict'
import { commandProgress } from '../dist/integration/commands.js'

// Pi rejects every use of a ctx once the session that issued it is replaced.
function progressContext(live, widgets) {
  return { hasUI: true, signal: undefined, ui: {
    setWidget: (...args) => { assert.ok(live.value, 'replaced session'); widgets.push(args[0]) },
    onTerminalInput: () => () => {},
  } }
}

test('a command row appears once a command lasts and goes when it ends', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const widgets = []
  const progress = commandProgress(progressContext({ value: true }, widgets), 'devices', 'load sensor', () => true)
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
  const progress = commandProgress(progressContext(live, widgets), 'devices', 'load sensor', () => live.value)
  live.value = false // The session was replaced while the command kept running in the shared runtime.
  t.mock.timers.tick(200)
  progress.end()
  assert.deepEqual(widgets, [])
})

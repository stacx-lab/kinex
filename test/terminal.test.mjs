import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withTerminal, cancelTerminalOperation } from '../dist/integration/terminal.js'
const request = () => ({ message: 'Test terminal operation', signal: new AbortController().signal })
function tty(t) {
  for (const stream of [process.stdin, process.stdout]) {
    const descriptor = Object.getOwnPropertyDescriptor(stream, 'isTTY')
    Object.defineProperty(stream, 'isTTY', { configurable: true, value: true })
    t.after(() => descriptor ? Object.defineProperty(stream, 'isTTY', descriptor) : delete stream.isTTY)
  }
}

test('terminal handoff restores the TUI after success and errors', async t => {
  tty(t)
  for (const failure of [false, true]) {
    const calls = []
    const ctx = { mode: 'tui', ui: { custom: factory => new Promise((resolve, reject) => {
      Promise.resolve(factory({ stop() { calls.push('stop') }, start() { calls.push('start') }, requestRender() { calls.push('render') } }, {}, {}, resolve)).catch(reject)
    }) } }
    const action = () => { calls.push('action'); return failure ? Promise.reject(new Error('failed')) : Promise.resolve('ok') }
    if (failure) await assert.rejects(withTerminal(ctx, request(), action), /failed/)
    else assert.deepEqual(await withTerminal(ctx, request(), action), { status: 'completed', value: 'ok' })
    assert.deepEqual(calls, ['stop', 'action', 'start', 'render'])
    assert.equal(cancelTerminalOperation(), false)
  }
})

test('terminal cancellation owns only the active handoff and restores the TUI', async t => {
  tty(t)
  const calls = []
  const ctx = { mode: 'tui', ui: { custom: factory => new Promise((resolve, reject) => {
    Promise.resolve(factory({ stop() { calls.push('stop') }, start() { calls.push('start') }, requestRender() { calls.push('render') } }, {}, {}, resolve)).catch(reject)
  }) } }
  assert.equal(cancelTerminalOperation(), false)
  const pending = withTerminal(ctx, request(), signal => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }))
  const cancelled = assert.rejects(pending, /installation cancelled; packages remain incomplete/)
  assert.equal(cancelTerminalOperation(), true)
  await cancelled
  assert.equal(cancelTerminalOperation(), false)
  assert.deepEqual(calls, ['stop', 'start', 'render'])
})

test('headless terminal requests report unavailable without invoking UI or action', async () => {
  const result = await withTerminal({ mode: 'print' }, request(), () => { throw new Error('must not execute') })
  assert.deepEqual(result, { status: 'unavailable' })
})

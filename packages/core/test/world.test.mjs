import { test } from 'node:test'
import assert from 'node:assert/strict'
import { worldResult } from '../dist/device/world.js'

const reading = data => ({ deviceID: 'world', kind: 'world', data })

test('world reads preserve optional episode budgets in seconds without enforcing them', () => {
  assert.deepEqual(worldResult('read', reading({ time_s: 42, extra: true })), reading({ time_s: 42 }))
  for (const budget of [
    { used_s: 0, max_s: null },
    { used_s: .25, max_s: 10.5 },
    { used_s: 11, max_s: 10 },
  ]) {
    assert.deepEqual(worldResult('read', reading({ time_s: 42, budget, extra: true })), reading({ time_s: 42, budget }))
  }
})

test('world reads reject malformed or legacy budgets', () => {
  for (const budget of [
    null, {}, { used_s: 0 }, { max_s: 10 }, { elapsed_s: 0, max_s: 10 },
    ...[-1, NaN, Infinity, -Infinity, '1', false].map(used_s => ({ used_s, max_s: 10 })),
    ...[0, -1, NaN, Infinity, -Infinity, '10', false].map(max_s => ({ used_s: 0, max_s })),
    { used: 1, max: 10, unit: 'seconds' },
    ...['used', 'max', 'unit'].map(key => ({ used_s: 1, max_s: 10, [key]: 1 })),
  ]) {
    assert.throws(() => worldResult('read', reading({ time_s: 42, budget })), { name: 'ZodError' })
  }
})

test('world waits keep their clock-only result contract', () => {
  assert.throws(() => worldResult('wait', reading({ time_s: 42, elapsed_s: .5 })), { name: 'ZodError' })
  for (const budget of [undefined, { used_s: 8, max_s: 10 }, { used: -1, max: 0, unit: 'frames' }]) {
    assert.deepEqual(worldResult('wait', reading({ time_s: 42, waited_s: .5, budget, extra: true })),
      reading({ time_s: 42, waited_s: .5 }))
  }
  assert.throws(() => worldResult('wait', reading({ time_s: 42, budget: { used_s: 8, max_s: 10 } })), { name: 'ZodError' })
})

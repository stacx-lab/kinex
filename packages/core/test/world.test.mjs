import { test } from 'node:test'
import assert from 'node:assert/strict'
import { worldResult } from '../dist/device/world.js'

test('world readings keep the clock and the episode budget a world reports, and drop anything else', () => {
  const budget = { used: 71, max: 5000, unit: 'action_frames' }
  const wait = worldResult('wait', { data: { time_s: 3.3, elapsed_s: 3.3, budget, extra: 1 } })
  assert.deepEqual(wait.data, { time_s: 3.3, elapsed_s: 3.3, budget })
  assert.deepEqual(worldResult('read', { data: { time_s: 0, budget: { ...budget, max: null } } }).data, { time_s: 0, budget: { ...budget, max: null } })
  assert.deepEqual(worldResult('read', { data: { time_s: 1 } }).data, { time_s: 1 })
  assert.throws(() => worldResult('read', { data: { time_s: 1, budget: { used: -1, max: 10, unit: 'steps' } } }))
})

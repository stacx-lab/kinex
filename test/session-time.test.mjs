import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatElapsed, sessionTime, sessionTimeEntry } from '../dist/integration/session-time.js'

test('session time accumulates work across requests, excluding idle time and nested user waits', () => {
  let now = 0
  const saved = []
  const time = sessionTime(milliseconds => saved.push(milliseconds), () => now)
  now = 10000
  assert.equal(time.milliseconds, 0)
  time.start()
  now += 2500
  time.start() // Retries and automatic continuation belong to the same active interval.
  now += 1500
  assert.equal(time.milliseconds, 4000)
  time.pause()
  time.pause()
  now += 60000
  time.resume()
  assert.equal(time.active, false)
  assert.equal(time.milliseconds, 4000)
  time.resume()
  now += 3000
  time.stop()
  time.stop()
  now += 60000
  assert.equal(time.milliseconds, 7000)
  time.start()
  now += 2000
  time.pause()
  time.stop() // Cancellation while the user dialog is still open.
  time.resume()
  now += 60000
  assert.equal(time.active, false)
  assert.equal(time.milliseconds, 9000)
  assert.deepEqual(saved, [4000, 3000, 2000])
})

test('session time restores saved work across resume and compaction without including downtime', () => {
  let now = 100000
  const saved = []
  const time = sessionTime(milliseconds => saved.push(milliseconds), () => now)
  const entry = milliseconds => ({ type: 'custom', customType: sessionTimeEntry, data: { milliseconds } })
  time.restore([entry(2500), { type: 'compaction' }, entry(4500), entry(-1), entry(Infinity), entry('1000'),
    { type: 'custom', customType: 'unrelated', data: { milliseconds: 5000 } }])
  assert.equal(time.milliseconds, 7000)
  time.start()
  now += 1000
  time.stop()
  assert.equal(time.milliseconds, 8000)
  assert.deepEqual(saved, [1000])
  time.restore([])
  assert.equal(time.milliseconds, 0)
  assert.equal(time.active, false)
  for (const [value, expected] of [[0, '0s'], [999, '0s'], [59000, '59s'], [60000, '1m00s'], [3599000, '59m59s'], [3601000, '1h00m01s']])
    assert.equal(formatElapsed(value), expected)
})

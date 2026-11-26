import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { BEAT_MS, heartbeat } from '../dist/common/heartbeat.js'

test('a job writes newlines more often than pi-subagents takes a silent sub-agent for one that needs attention, and only newlines', async () => {
  assert.ok(BEAT_MS < 60_000, 'pi-subagents waits 60 s')
  const written = []
  const stop = heartbeat(text => written.push(text), 10)
  await sleep(100)
  stop()
  const count = written.length
  assert.ok(count > 2, 'it beats while the job works')
  // pi-subagents trims a failed command's standard error into its error, which newlines leave unchanged.
  assert.equal(written.join('').trim(), '')
  await sleep(50)
  assert.equal(written.length, count, 'it ends with the job')
})

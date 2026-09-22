import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatJSON, omitEmptyOptional } from '../dist/util/json.js'
import { renderReading } from '../dist/tool/device/shared.js'
import { recordingOutput } from '../dist/record/output.js'

test('JSON indents only two levels and retains JSON serialization semantics', () => {
  const value = { state: { positions: [0, 1, 2], details: { source: 'driver', values: [1, 2] } } }
  assert.equal(formatJSON(value), '{\n  "state": {\n    "positions": [0,1,2],\n    "details": {"source":"driver","values":[1,2]}\n  }\n}')
  assert.equal(formatJSON(value, true), JSON.stringify(value))
  for (const item of [value, [value], { empty: {}, list: [], omitted: undefined, quote: '\n"\\' }, [undefined, null], null]) {
    assert.deepEqual(JSON.parse(formatJSON(item)), JSON.parse(JSON.stringify(item)))
  }
  assert.equal(formatJSON(undefined), 'null')
})

test('optional cleanup is explicit, nonmutating and preserves meaningful falsy values', () => {
  const value = { readings: { arm: { empty: [], faults: [], custom: {} } }, optional: '', null: null, zero: 0, false: false }
  const before = structuredClone(value)
  assert.deepEqual(omitEmptyOptional(value, ['readings.*.empty', 'optional', 'null', 'zero', 'false']), {
    readings: { arm: { faults: [], custom: {} } }, null: null, zero: 0, false: false,
  })
  assert.deepEqual(value, before)
  assert.deepEqual(omitEmptyOptional([{ optional: [], keep: [] }], ['*.optional']), [{ keep: [] }])
})

test('device output defaults to full data and only drops empty optional feedback', () => {
  const data = { accepted: true, elapsed_s: 0, reached: false, state: {
    positions: [0], velocities: [], efforts: [], frame_poses: {}, faults: [], sample_time_s: null, received_time_s: 0, custom: [],
  } }
  const reading = { data, filePath: '/tmp/frame.png' }
  assert.deepEqual(JSON.parse(renderReading({ data })), data)
  const concise = JSON.parse(renderReading({ data }, false))
  assert.deepEqual(concise, { ...data, state: { positions: [0], faults: [], sample_time_s: null, received_time_s: 0, custom: [] } })
  assert.deepEqual(JSON.parse(renderReading({ data: { velocities: [0], frame_poses: { tool: [0, 1] } } }, false)), { velocities: [0], frame_poses: { tool: [0, 1] } })
  assert.equal(renderReading(reading, false, true), `written to /tmp/frame.png\n${JSON.stringify(concise)}`)
  assert.deepEqual(data.state.velocities, [])
})

test('recording output cleans only optional empty annotations and bookkeeping', () => {
  const manifest = { id: 'recording', devices: {}, passive: {}, messageRange: {}, labels: [], task: '', bytes: 0, quotaHit: false, error: '' }
  const value = { manifest, applied: {}, refusals: {}, readings: { arm: { data: { faults: [] } } } }
  assert.deepEqual(JSON.parse(recordingOutput(value)), value)
  assert.deepEqual(JSON.parse(recordingOutput(value, false)), {
    manifest: { id: 'recording', devices: {}, bytes: 0, quotaHit: false, error: '' }, applied: {}, readings: { arm: { data: { faults: [] } } },
  })
  assert.deepEqual(JSON.parse(recordingOutput({ running: null, recent: [manifest], refusals: { arm: 'unloaded' } }, false)), {
    running: null, recent: [{ id: 'recording', devices: {}, bytes: 0, quotaHit: false, error: '' }], refusals: { arm: 'unloaded' },
  })
})

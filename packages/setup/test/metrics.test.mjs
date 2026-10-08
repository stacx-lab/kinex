import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { measure, parseSession, markdownRow } from '../script/onboarding-metrics.mjs'

const exec = promisify(execFile)
const script = fileURLToPath(new URL('../script/onboarding-metrics.mjs', import.meta.url))

function entry(id, parentId, seconds, message) {
  return { type: 'message', id, parentId, timestamp: new Date(Date.UTC(2026, 9, 7, 10, 0, seconds)).toISOString(), message }
}
const usage = (input, output) => ({ input, output, cacheRead: 100, cacheWrite: 10 })
const assistant = (content, input = 1000, output = 50) => ({ role: 'assistant', content, api: 'test', provider: 'test', model: 'test', usage: usage(input, output), stopReason: 'toolUse', timestamp: 0 })
const result = (toolName, text, isError = false) => ({ role: 'toolResult', toolCallId: 'c', toolName, content: [{ type: 'text', text }], isError, timestamp: 0 })

function session() {
  const rows = [
    { type: 'session', version: 3, id: 'metrics', timestamp: '2026-10-07T10:00:00.000Z', cwd: '/w' },
    entry('u0', null, 0, { role: 'user', content: 'hello', timestamp: 0 }),
    entry('a0', 'u0', 1, assistant([{ type: 'text', text: 'hi' }], 5000, 5)),
    entry('u1', 'a0', 10, { role: 'user', content: 'Register a new device for the workspace robot: go2', timestamp: 0 }),
    entry('a1', 'u1', 20, assistant([{ type: 'toolCall', id: 'c', name: 'write', arguments: { path: '/w/.kinex/devices/go2/driver.py', content: '' } }])),
    entry('t1', 'a1', 21, result('write', 'ok')),
    entry('a2', 't1', 30, assistant([{ type: 'toolCall', id: 'c', name: 'profile_write', arguments: { kind: 'device', data: {} } }], 2000, 80)),
    entry('t2', 'a2', 31, result('profile_write', 'validation failed: x', true)),
    entry('a3', 't2', 40, assistant([{ type: 'toolCall', id: 'c', name: 'profile_write', arguments: { kind: 'device', data: {} } }])),
    entry('t3', 'a3', 41, result('profile_write', 'device go2 written')),
    entry('a4', 't3', 50, assistant([{ type: 'toolCall', id: 'c', name: 'device', arguments: { deviceID: 'go2', action: 'load' } }])),
    entry('t4', 'a4', 70, result('device', '{"loaded": true}')),
    entry('a5', 't4', 80, assistant([{ type: 'text', text: 'go2 loaded' }], 3000, 20)),
    entry('u2', 'a5', 90, { role: 'user', content: 'thanks', timestamp: 0 }),
    entry('a6', 'u2', 91, assistant([{ type: 'text', text: 'done' }], 9000, 9)),
  ]
  return rows.map(row => JSON.stringify(row)).join('\n') + '\n'
}

test('metrics slice from the workflow opener to the first successful load', async () => {
  const measured = measure(parseSession(session()))
  assert.equal(measured.wall_clock_s, 60)
  assert.equal(measured.model_turns, 4)
  assert.deepEqual(measured.tool_calls, { device: 1, profile_write: 2, write: 1 })
  assert.deepEqual(measured.tokens, { input: 5000, output: 230, cacheRead: 400, cacheWrite: 40 })
  assert.equal(measured.profile_write_failures, 1)
  assert.equal(measured.driver_edits, 1)
  assert.deepEqual(measured.files_written, ['/w/.kinex/devices/go2/driver.py'])
  assert.match(markdownRow('go2', measured), /^\| go2 \| 60 \| 4 \| 4 \| 5000 \| 230 \| 400 \| 40 \| 1 \| 1 \|$/)
})

test('metrics recognize the explicit ROS onboarding workflow', () => {
  const entries = parseSession(session())
  entries.find(entry => entry.id === 'u1').message.content = 'Load the onboard-ros2 skill and follow it for ROS 2 hardware onboarding.'
  assert.equal(measure(entries).wall_clock_s, 60)
})

test('metrics follow the active branch and fall back to the last assistant message', () => {
  const rows = session().trim().split('\n').map(row => JSON.parse(row))
  const forked = [...rows, entry('a7', 'u1', 95, assistant([{ type: 'text', text: 'other branch' }], 1, 1))]
  const measured = measure(parseSession(forked.map(row => JSON.stringify(row)).join('\n')), { until: /never matches/ })
  assert.equal(measured.model_turns, 1)
  assert.equal(measured.tokens.input, 1)
  assert.throws(() => measure(parseSession(session()), { from: /missing opener/ }), /no user message matches/)
})

test('metrics finish on a successful load, not guide text, status, or failed loads', () => {
  const rows = [
    entry('u', null, 0, { role: 'user', content: 'Register a new device: arm' }),
    entry('a1', 'u', 1, assistant([{ type: 'toolCall', id: 'c', name: 'read', arguments: { path: '/w/.kinex/devices/arm/DEVICE.md' } }])),
    entry('t1', 'a1', 2, result('read', 'Example: loaded: false. A loaded robot is ready.')),
    entry('a2', 't1', 3, assistant([{ type: 'toolCall', id: 'c', name: 'device', arguments: { deviceID: 'arm', action: 'status' } }])),
    entry('t2', 'a2', 4, result('device', '{"loaded":true}')),
    entry('a3', 't2', 5, assistant([{ type: 'toolCall', id: 'c', name: 'device', arguments: { deviceID: 'arm', action: 'load' } }])),
    entry('t3', 'a3', 6, result('device', 'device could not be loaded', true)),
    entry('a4', 't3', 7, assistant([{ type: 'toolCall', id: 'c', name: 'device', arguments: { deviceID: 'arm', action: 'load' } }])),
    entry('t4', 'a4', 30, result('device', '{"loaded":true}')),
  ]
  const measured = measure(rows)
  assert.equal(measured.wall_clock_s, 30)
  assert.equal(measured.model_turns, 4)
  assert.deepEqual(measured.tool_calls, { device: 3, read: 1 })
  assert.deepEqual(measured.files_written, [])
  assert.equal(measure(rows, { until: /Example:/ }).wall_clock_s, 2)
})

test('metrics preserve metadata parents and a metadata leaf on the active branch', () => {
  const rows = session().trim().split('\n').map(JSON.parse)
  for (const type of ['model_change', 'compaction', 'custom', 'thinking_level_change', 'usage']) {
    const changed = rows.map(row => row.id === 'a4' ? { ...row, parentId: 'metadata' } : row)
    changed.splice(changed.findIndex(row => row.id === 'a4'), 0, { type, id: 'metadata', parentId: 't3' })
    changed.push({ type: 'session_info', id: 'leaf', parentId: 'a6', name: 'Onboarding' })
    assert.deepEqual(measure(parseSession(changed.map(JSON.stringify).join('\n'))), measure(parseSession(session())), type)
  }
})

test('metrics recognize successful batched device loads', () => {
  const rows = session().trim().split('\n').map(JSON.parse)
  const call = rows.find(row => row.id === 'a4').message.content[0]
  call.name = 'devices'
  call.arguments = { calls: [{ deviceID: 'go2', action: 'load' }] }
  rows.find(row => row.id === 't4').message = result('devices', '{"results":[{"deviceID":"go2","action":"load","ok":true}]}')
  assert.equal(measure(parseSession(rows.map(JSON.stringify).join('\n'))).wall_clock_s, 60)
})

test('metrics CLI prints JSON for a session file', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kinex-metrics-'))
  try {
    const file = path.join(directory, 'session.jsonl')
    await writeFile(file, session())
    const { stdout } = await exec(process.execPath, [script, file, '--json'])
    assert.equal(JSON.parse(stdout).wall_clock_s, 60)
    const table = await exec(process.execPath, [script, file])
    assert.match(table.stdout, /\| wall-clock s \|/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

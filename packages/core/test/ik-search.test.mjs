import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { JointKinematics } from '../dist/device/profile/joint.js'

test('numerical IK search options default identically to the Python runtime', () => {
  const base = { frame: 'tip', fk: 'numerical', frame_to_reported: [0, 0, 0, 0, 0, 0, 1],
    ik: { backend: 'numerical', method: 'damped_least_squares', position_tolerance_m: .001,
      rotation_tolerance_rad: .001, max_iterations: 200, damping: .01 } }
  assert.equal(JointKinematics.parse(base).ik.search, undefined)
  const parse = search => JointKinematics.parse({ ...base, ik: { ...base.ik, search } }).ik.search
  assert.deepEqual(parse({}), { max_attempts: 5, attempt_time_s: .02, max_time_s: .1 })
  assert.deepEqual(parse({ max_attempts: 1 }), { max_attempts: 1, attempt_time_s: .02, max_time_s: .1 })
  for (const search of [null, [], { unknown: 1 }, ...[true, false, 0, -1, 1.5, '5', Infinity].map(max_attempts => ({ max_attempts })),
    ...['attempt_time_s', 'max_time_s'].flatMap(key => [true, 0, -1, '1', Infinity, NaN].map(value => ({ [key]: value })))])
    assert.throws(() => parse(search))
  assert.throws(() => JointKinematics.parse({ ...base,
    ik: { backend: 'driver', frame_to_solver: [0, 0, 0, 0, 0, 0, 1],
      position_tolerance_m: .001, rotation_tolerance_rad: .001, search: {} } }))
})

test('bounded DLS search and real controller composition preserve IK contracts', () => {
  execFileSync(process.env.PYTHON ?? 'python3', [fileURLToPath(new URL('./ik_search.py', import.meta.url))], {
    env: { ...process.env, PYTHONPATH: fileURLToPath(new URL('../assets/python', import.meta.url)), PYTHONDONTWRITEBYTECODE: '1' },
    encoding: 'utf8',
  })
})

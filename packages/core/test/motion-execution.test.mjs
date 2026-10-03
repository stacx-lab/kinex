import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Pose, Transform } from '../dist/device/profile/common.js'

test('persisted calibration poses and transforms retain strict quaternion validation', () => {
  for (const rotation of [[0, 0, 0, 1], [0, 0, 0, -1]]) {
    assert.deepEqual(Pose.parse([0, 0, 0, ...rotation]), [0, 0, 0, ...rotation])
    assert.deepEqual(Transform.parse({ translation_m: [0, 0, 0], rotation_xyzw: rotation }).rotation_xyzw, rotation)
  }
  for (const rotation of [[.964, .264, .032, .011], [0, 0, .707, .707], [0, 0, 0, .9995]]) {
    assert.throws(() => Pose.parse([0, 0, 0, ...rotation]), /unit quaternion/)
    assert.throws(() => Transform.parse({ translation_m: [0, 0, 0], rotation_xyzw: rotation }), /unit quaternion/)
  }
})

test('shipped executor and trajectory generator obey motion contracts', () => {
  execFileSync(process.env.PYTHON ?? 'python3', [fileURLToPath(new URL('./motion_execution.py', import.meta.url))], {
    env: { ...process.env, PYTHONPATH: fileURLToPath(new URL('../assets/python', import.meta.url)) },
    encoding: 'utf8',
  })
})

test('hardware buffers and world waits support replacement and independent cancellation', () => {
  execFileSync(process.env.PYTHON ?? 'python3', [fileURLToPath(new URL('./driver_contract.py', import.meta.url))], {
    env: { ...process.env, PYTHONPATH: fileURLToPath(new URL('../assets/python', import.meta.url)) },
    encoding: 'utf8',
  })
})

test('joint poses use explicit local frames and measured-state FK', () => {
  execFileSync(process.env.PYTHON ?? 'python3', [fileURLToPath(new URL('./joint_frames.py', import.meta.url))], {
    env: { ...process.env, PYTHONPATH: fileURLToPath(new URL('../assets/python', import.meta.url)) },
    encoding: 'utf8',
  })
})

test('camera output modes preserve image bytes and array ownership', () => {
  execFileSync(process.env.PYTHON ?? 'python3', [fileURLToPath(new URL('./camera_output.py', import.meta.url))], {
    env: { ...process.env, PYTHONPATH: fileURLToPath(new URL('../assets/python', import.meta.url)) },
    encoding: 'utf8',
  })
})

test('shipped scalar and world templates obey feedback and clock contracts', () => {
  execFileSync(process.env.PYTHON ?? 'python3', [fileURLToPath(new URL('./driver_templates.py', import.meta.url))], {
    env: { ...process.env, PYTHONPATH: fileURLToPath(new URL('../assets/python', import.meta.url)) },
    encoding: 'utf8',
  })
})

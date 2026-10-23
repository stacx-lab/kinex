import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('geometry, joint, locomotion and trajectory helpers obey motion contracts', () => {
  execFileSync(process.env.PYTHON ?? 'python3', [fileURLToPath(new URL('./motion.py', import.meta.url))], {
    env: { ...process.env, PYTHONPATH: fileURLToPath(new URL('../assets/python', import.meta.url)) },
    encoding: 'utf8',
  })
})

test('joint models follow URDF order and compute mimic-aware link FK and IK', () => {
  execFileSync(process.env.PYTHON ?? 'python3', [fileURLToPath(new URL('./joint_model.py', import.meta.url))], {
    env: { ...process.env, PYTHONPATH: fileURLToPath(new URL('../assets/python', import.meta.url)) },
    encoding: 'utf8',
  })
})

test('camera images convert ROS payloads and locate registered depth', () => {
  execFileSync(process.env.PYTHON ?? 'python3', [fileURLToPath(new URL('./camera_images.py', import.meta.url))], {
    env: { ...process.env, PYTHONPATH: fileURLToPath(new URL('../assets/python', import.meta.url)) },
    encoding: 'utf8',
  })
})

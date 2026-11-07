import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { CameraColor, CameraDistortion } from '../dist/device/profile/camera.js'
test('distortion metadata is opaque', () => {
  const d = { model: 'vendor_future', coefficients: [1,2], metadata: { revision: 'v3' } }
  assert.deepEqual(CameraDistortion.parse(d), d)
  assert.equal(CameraDistortion.safeParse({model:''}).success, false)
  assert.equal(CameraColor.parse({distortion:d}).fov, '???')
  assert.deepEqual(CameraColor.parse({distortion:d, fov:{horizontal_deg:70,vertical_deg:50}}).fov,
    {horizontal_deg:70,vertical_deg:50})
})
test('camera geometry services', () => {
  execFileSync(process.env.PYTHON ?? 'python3', [fileURLToPath(new URL('./camera_geometry.py', import.meta.url))],
    {env:{...process.env,PYTHONPATH:fileURLToPath(new URL('../assets/python',import.meta.url))}})
})

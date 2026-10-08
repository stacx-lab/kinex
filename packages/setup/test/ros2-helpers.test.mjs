import { Assets as CoreAssets } from '@kinex/core/installation/assets'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

test('ROS transport helpers verify feedback, identity and bounded cleanup without ROS', () => {
  execFileSync(process.env.PYTHON ?? 'python3', [fileURLToPath(new URL('./ros2_helpers.py', import.meta.url))], {
    env: { ...process.env, PYTHONPATH: [CoreAssets.python(), fileURLToPath(new URL('../assets/python', import.meta.url)),
      fileURLToPath(new URL('./fake_rclpy', import.meta.url))].join(path.delimiter), PYTHONDONTWRITEBYTECODE: '1' },
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
})

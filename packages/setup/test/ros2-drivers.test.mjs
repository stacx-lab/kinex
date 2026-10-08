import { Assets as CoreAssets } from '@kinex/core/installation/assets'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

for (const [file, description] of [
  ['ros2_drivers.py', 'ROS adapters preserve motion, feedback, camera and cleanup contracts'],
  ['ros2_check.py', 'ROS checks emit measured evidence and enforce recorded identity'],
]) {
  test(description, () => {
    execFileSync(process.env.PYTHON ?? 'python3', [fileURLToPath(new URL(file, import.meta.url))], {
      env: { ...process.env, PYTHONPATH: [CoreAssets.python(), fileURLToPath(new URL('../assets/python', import.meta.url)),
        fileURLToPath(new URL('./fake_rclpy', import.meta.url))].join(path.delimiter), PYTHONDONTWRITEBYTECODE: '1' },
      encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'],
    })
  })
}

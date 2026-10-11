import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { Assets as CoreAssets } from '@kinex/core/installation/assets'

for (const [file, description] of [
  ['bundle_helpers.py', 'ROS provisioning checks prerequisites, resumes and preserves selected files'],
  ['ros2_helpers.py', 'ROS transport preserves cancellation and bounded cleanup'],
  ['ros2_drivers.py', 'ROS adapters preserve feedback, motion, sensors and cleanup'],
  ['ros2_check.py', 'ROS interface checks report measurements and failures'],
]) {
  test(description, () => {
    execFileSync(process.env.PYTHON ?? 'python3', [fileURLToPath(new URL(file, import.meta.url))], {
      env: { ...process.env, PYTHONPATH: [CoreAssets.python(), fileURLToPath(new URL('../assets/python', import.meta.url)),
        fileURLToPath(new URL('./fake_rclpy', import.meta.url))].join(path.delimiter), PYTHONDONTWRITEBYTECODE: '1' },
      encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'],
    })
  })
}

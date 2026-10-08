import path from 'node:path'
import { Assets as CoreAssets } from '@kinex/core/installation/assets'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('bundle helpers validate manifests, facts and provisioning without ROS', () => {
  execFileSync(process.env.PYTHON ?? 'python3', [fileURLToPath(new URL('./bundle_helpers.py', import.meta.url))], {
    env: { ...process.env, PYTHONPATH: [CoreAssets.python(), fileURLToPath(new URL('../assets/python', import.meta.url))].join(path.delimiter) },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
})

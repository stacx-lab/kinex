import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('provisioned driver templates retain buffer and clock contracts', () => {
  execFileSync(process.env.PYTHON ?? 'python3', [fileURLToPath(new URL('./driver_templates.py', import.meta.url))], {
    env: { ...process.env, PYTHONPATH: fileURLToPath(new URL('../assets/python', import.meta.url)) },
    encoding: 'utf8',
  })
})

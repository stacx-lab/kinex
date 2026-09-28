import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

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

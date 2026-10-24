import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('reference nodes name themselves legally and reject unrecorded facts', () => {
  execFileSync(process.env.PYTHON ?? 'python3', [fileURLToPath(new URL('./reference_nodes.py', import.meta.url))], {
    env: { ...process.env, PYTHONPATH: fileURLToPath(new URL('../assets/python', import.meta.url)), PYTHONDONTWRITEBYTECODE: '1' },
    encoding: 'utf8',
  })
})

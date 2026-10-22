import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('bounded DLS search preserves IK contracts on URDF chains', () => {
  execFileSync(process.env.PYTHON ?? 'python3', [fileURLToPath(new URL('./ik_search.py', import.meta.url))], {
    env: { ...process.env, PYTHONPATH: fileURLToPath(new URL('../assets/python', import.meta.url)), PYTHONDONTWRITEBYTECODE: '1' },
    encoding: 'utf8',
  })
})

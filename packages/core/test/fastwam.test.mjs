import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const device = path.join(root, 'assets/builtin/device/fastwam')
const python = process.env.PYTHON ?? 'python3'

test('FastWAM artifact verification requires neither torch nor robot access', () => {
  const script = `
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
import hashlib
sys.path.insert(0, ${JSON.stringify(device)})
from provision import verify
assert 'torch' not in sys.modules
with TemporaryDirectory() as directory:
    file = Path(directory) / 'weights'
    file.write_bytes(b'checkpoint')
    artifact = {'size': 10, 'sha256': hashlib.sha256(b'checkpoint').hexdigest()}
    assert verify(file, artifact)
    file.write_bytes(b'corruption')
    assert not verify(file, artifact)
`
  const result = spawnSync(python, ['-c', script], {
    env: { ...process.env, PYTHONPATH: path.join(root, 'assets/python') }, encoding: 'utf8', timeout: 10000,
  })
  assert.equal(result.status, 0, result.stderr)
})

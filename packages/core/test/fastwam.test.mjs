import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const device = path.join(root, 'assets/builtin/device/fastwam')
const python = process.env.PYTHON ?? 'python3'

test('FastWAM discovery and failed activation require neither torch nor robot access', () => {
  const script = `
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
import hashlib
sys.path.insert(0, ${JSON.stringify(device)})
import driver
from provision import verify
assert 'torch' not in sys.modules
assert driver.handle('status', {}) == {'ok': True, 'loaded': False, 'variant': None}
assert driver.handle('read', {})['loaded'] is False
assert 'not loaded' in driver.handle('infer', {})['error']
driver.settings = lambda: {'intrinsics': {'variant': 'libero_uncond_2cam224'}, 'access': {'connection': {'kind': 'process', 'compute': {'kind': 'cuda', 'index': 0}}}}
result = driver.handle('load', {})
assert not result['ok'] and 'not provisioned' in result['error'], result
assert driver.handle('status', {})['loaded'] is False
assert 'torch' not in sys.modules
assert driver.handle('unload', {})['unloaded'] is True
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

test('all FastWAM variants register typed operation contracts and pinned artifacts', async () => {
  const { createKinexRuntime } = await import('../dist/index.js')
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kinex-fastwam-'))
  const runtime = createKinexRuntime({ directory })
  try {
    const generated = spawnSync(python, ['-c', `
import json, sys
sys.path.insert(0, ${JSON.stringify(device)})
from fastwam_config import make_profile, VARIANTS
print(json.dumps([make_profile(${JSON.stringify(device)}, variant) for variant in VARIANTS]))
`], { encoding: 'utf8', timeout: 10000 })
    assert.equal(generated.status, 0, generated.stderr)
    for (const profile of JSON.parse(generated.stdout)) {
      await runtime.profiles.writeDevice(profile)
      assert.equal(profile.loaded, false)
      assert.equal(profile.intrinsics.operations[0].output.properties.actions.minItems, 32)
      assert.ok(profile.intrinsics.artifacts.every(a => /^[a-f0-9]{40}$/.test(a.source.revision)))
    }
    const catalog = await runtime.devices.templates()
    assert.ok(catalog.some(entry => entry.name === 'fastwam'))
  } finally {
    await runtime.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

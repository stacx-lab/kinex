import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile, readFile, stat, mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { createKinexRuntime, PermissionDeniedError } from '@kinex/core'
import { createKinexSetup } from '../dist/index.js'
import { Assets } from '../dist/assets.js'

async function fixture(t, source, mode = 'auto', host = {}) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'kinex-apt-'))
  const library = path.join(cwd, 'assets/python')
  await mkdir(path.join(library, 'kinex_ros'), { recursive: true })
  await writeFile(path.join(library, 'kinex_ros/__init__.py'), '')
  await writeFile(path.join(library, 'kinex_ros/bundle_install.py'), source)
  t.mock.method(Assets, 'python', (...segments) => path.join(library, ...segments))
  const runtime = createKinexRuntime({ directory: cwd, host: { ask: async () => {
    if (mode === 'ask') throw new PermissionDeniedError('shell')
  } } })
  t.after(async () => { await runtime.dispose(); await rm(cwd, { recursive: true, force: true }) })
  return { cwd, runtime, setup: createKinexSetup(runtime, { host }) }
}

test('package installation obeys shell permission before starting Python', async t => {
  const { cwd, setup } = await fixture(t, 'raise RuntimeError("must not execute")', 'ask')
  await assert.rejects(setup.tools.call('kinex_install_apt', { packages: ['driver'] }, { sessionID: 'apt' }), /[Pp]ermission/)
  await assert.rejects(stat(path.join(cwd, '.kinex/python')), { code: 'ENOENT' })
})

test('headless apt tool returns authentication recovery without attempting terminal input', { skip: process.platform !== 'linux' }, async t => {
  const { setup } = await fixture(t, `import json, sys
assert '--interactive' not in sys.argv
print(json.dumps({'status': 'needs', 'needs': [{'reason': 'sudo_authentication', 'command': 'terminal recovery'}]}))
sys.exit(2)
`)
  const result = await setup.tools.call('kinex_install_apt', { packages: ['driver'] }, { sessionID: 'apt' })
  assert.equal(result.isError, true)
  assert.equal(result.metadata.result.needs[0].reason, 'sudo_authentication')
  assert.match(result.output, /terminal recovery/)
})

test('apt tool loads its bundled helper and imports despite workspace Python replacements', { skip: process.platform !== 'linux' }, async t => {
  const { cwd, setup } = await fixture(t, `import json
from kinex_ros.origin import source
print(json.dumps({'status': 'ok', 'source': source}))
`)
  await writeFile(path.join(cwd, 'assets/python/kinex_ros/origin.py'), "source = 'bundled'\n")
  await mkdir(path.join(cwd, 'kinex_ros'))
  const replacement = "from pathlib import Path\nPath('workspace-code-ran').write_text('bad')\nraise RuntimeError('workspace replacement')\n"
  for (const file of ['kinex_ros/__init__.py', 'kinex_ros/bundle_install.py', 'sitecustomize.py', 'json.py']) {
    await writeFile(path.join(cwd, file), replacement)
  }
  // Even site customizations in the library must not run during authentication.
  await writeFile(path.join(cwd, 'assets/python/sitecustomize.py'), replacement)
  const result = await setup.tools.call('kinex_install_apt', { packages: ['driver'] }, { sessionID: 'apt' })
  assert.equal(result.isError, false, result.output)
  assert.deepEqual(result.metadata.result, { status: 'ok', source: 'bundled' })
  await assert.rejects(stat(path.join(cwd, 'workspace-code-ran')), { code: 'ENOENT' })
})

test('package install cancellation terminates the owned subprocess group', { skip: process.platform !== 'linux', timeout: 8000 }, async t => {
  const command = `import subprocess, sys, time
from pathlib import Path
subprocess.Popen([sys.executable, '-c', "import signal, time; from pathlib import Path; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(2); Path('orphan').write_text('bad')"])
Path('started').write_text('yes')
time.sleep(60)
`
  const { cwd, setup } = await fixture(t, `import sys
sys.path.insert(0, ${JSON.stringify(Assets.python())})
from kinex_ros.bundle_install import _run
_run([sys.executable, '-c', ${JSON.stringify(command)}])
`)
  const abort = new AbortController()
  const pending = setup.tools.call('kinex_install_apt', { packages: ['driver'] }, { sessionID: 'apt', signal: abort.signal })
  const failed = pending.then(result => { assert.equal(result.isError, true); assert.match(result.output, /cancelled/) })
  for (let i = 0; i < 100; i++) {
    if (await stat(path.join(cwd, 'started')).then(() => true, () => false)) break
    await delay(10)
  }
  assert.equal(await readFile(path.join(cwd, 'started'), 'utf8'), 'yes')
  abort.abort(new Error('cancelled'))
  await failed
  await delay(2100)
  await assert.rejects(stat(path.join(cwd, 'orphan')), { code: 'ENOENT' })
})

test('terminal capability is requested once only after authentication is needed', { skip: process.platform !== 'linux' }, async t => {
  let calls = 0
  const { setup } = await fixture(t, `import json, sys
if '--interactive' in sys.argv:
    print(json.dumps({'status': 'ok'}))
else:
    print(json.dumps({'status': 'needs', 'needs': [{'reason': 'sudo_authentication'}]}))
    sys.exit(2)
`, 'auto', { withTerminal: async (request, action) => {
    calls++
    return { status: 'completed', value: await action(request.signal) }
  } })
  const result = await setup.tools.call('kinex_install_apt', { packages: ['driver'] }, { sessionID: 'apt' })
  assert.equal(result.isError, false, result.output)
  assert.equal(calls, 1)
})

test('unavailable terminal preserves authentication recovery', { skip: process.platform !== 'linux' }, async t => {
  let calls = 0
  const { setup } = await fixture(t, `import json, sys
assert '--interactive' not in sys.argv
print(json.dumps({'status': 'needs', 'needs': [{'reason': 'sudo_authentication', 'command': 'recovery'}]}))
sys.exit(2)
`, 'auto', { withTerminal: async () => { calls++; return { status: 'unavailable' } } })
  const result = await setup.tools.call('kinex_install_apt', { packages: ['driver'] }, { sessionID: 'apt' })
  assert.equal(result.isError, true)
  assert.equal(calls, 1)
  assert.match(result.output, /recovery/)
})


test('runtime disposal cancels an installer waiting in the terminal callback', { skip: process.platform !== 'linux', timeout: 8000 }, async t => {
  let entered
  const ready = new Promise(resolve => { entered = resolve })
  let restored = false
  const { cwd, runtime, setup } = await fixture(t, `import json, sys, time
from pathlib import Path
if '--interactive' in sys.argv:
    Path('started').write_text('yes')
    time.sleep(60)
else:
    print(json.dumps({'status': 'needs', 'needs': [{'reason': 'sudo_authentication'}]}))
    sys.exit(2)
`, 'auto', { withTerminal: async (request, action) => {
    try {
      const pending = action(request.signal)
      entered()
      return { status: 'completed', value: await pending }
    } finally { restored = true }
  } })
  const pending = setup.tools.call('kinex_install_apt', { packages: ['driver'] }, { sessionID: 'apt' })
  await ready
  for (let i = 0; i < 100; i++) {
    if (await stat(path.join(cwd, 'started')).then(() => true, () => false)) break
    await delay(10)
  }
  assert.equal(await readFile(path.join(cwd, 'started'), 'utf8'), 'yes')
  await runtime.dispose()
  assert.equal((await pending).isError, true)
  assert.equal(restored, true)
})

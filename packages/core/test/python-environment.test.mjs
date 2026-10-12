import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const home = await mkdtemp(path.join(os.tmpdir(), 'kinex-python-home-'))
process.env.KINEX_CONFIG_DIR = path.join(home, 'config')
process.env.KINEX_DATA_DIR = path.join(home, 'data')
after(() => rm(home, { recursive: true, force: true }))
const { createKinexRuntime } = await import('../dist/index.js')
const { pythonRuntime } = await import('../dist/python/environment.js')
const python = execFileSync(process.env.PYTHON ?? 'python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim()

async function until(check) {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (await check()) return
    await delay(10)
  }
  assert.fail('Timed out waiting for fake uv')
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kinex-python-'))
  const bin = path.join(directory, 'bin')
  const log = path.join(directory, 'syncs.jsonl')
  const config = path.join(directory, 'sync.json')
  const release = path.join(directory, 'release')
  await mkdir(bin)
  await writeFile(config, '{}')
  await writeFile(log, '')
  await writeFile(path.join(bin, 'uv'), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const config = JSON.parse(fs.readFileSync(${JSON.stringify(config)}, 'utf8'));
const args = process.argv.slice(2);
if (args[0] !== 'sync' || args[1] !== '--project') process.exit(3);
const executable = path.join(args[2], '.venv/bin/python3');
fs.mkdirSync(path.dirname(executable), { recursive: true });
if (!fs.existsSync(executable)) fs.symlinkSync(${JSON.stringify(python)}, executable);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ pid: process.pid, project: args[2] }) + '\\n');
const finish = () => {
  if (config.gate && !fs.existsSync(${JSON.stringify(release)})) return setTimeout(finish, 10);
  if (config.fail) { process.stderr.write('test synchronization failed'); process.exit(2); }
};
finish();
`, { mode: 0o755 })
  const previousPath = process.env.PATH
  process.env.PATH = [bin, previousPath].filter(Boolean).join(path.delimiter)
  const runtimes = []
  const create = () => {
    const runtime = createKinexRuntime({ directory, host: { ask: async () => {} } })
    runtimes.push(runtime)
    return runtime
  }
  const runtime = create()
  t.after(async () => {
    try { await Promise.all(runtimes.map(value => value.dispose())) }
    finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
      await rm(directory, { recursive: true, force: true })
    }
  })
  const status = await runtime.python.status()
  return {
    directory, runtime, status, create,
    launch: (signal, owner = runtime) => owner.run(() => pythonRuntime(directory, undefined, signal)),
    configure: value => writeFile(config, JSON.stringify(value)),
    release: () => writeFile(release, ''),
    calls: async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
    existing: async () => {
      await mkdir(path.dirname(status.executable), { recursive: true })
      await symlink(python, status.executable)
    },
    tool: async (source = 'import sys\nfrom kinex import finish\nfinish({"python": sys.executable})\n', interpreter) => {
      const tool = path.join(directory, '.kinex/tools/probe')
      await mkdir(tool, { recursive: true })
      await writeFile(path.join(tool, 'tool.yaml'), JSON.stringify({ name: 'probe', kind: 'perception', description: 'Python environment probe', ...(interpreter ? { interpreter } : {}) }))
      await writeFile(path.join(tool, 'tool.py'), source)
      return tool
    },
  }
}

test('existing default Python runs repeated and concurrent tools without uv or manifest synchronization', async t => {
  const f = await fixture(t)
  await f.existing()
  await f.tool()
  // No uv can be located; the absolute Python executable must still work.
  process.env.PATH = ''
  const call = () => f.runtime.tools.call('probe', {}, { sessionID: 'python' })
  for (let i = 0; i < 2; i++) {
    const result = await call()
    assert.ok(!result.isError, result.output)
  }
  await writeFile(path.join(f.status.project, 'pyproject.toml'), 'changed; deliberately not valid TOML')
  await writeFile(path.join(f.status.project, 'uv.lock'), 'changed lockfile')
  const results = await Promise.all(Array.from({ length: 6 }, call))
  for (const result of results) {
    assert.ok(!result.isError, result.output)
    assert.equal(JSON.parse(result.output).python, f.status.executable)
  }
  assert.deepEqual(await f.calls(), [])
})

test('exec discovery is inert and default execution lazily prepares and reuses Kinex Python', async t => {
  const f = await fixture(t)
  const catalog = await f.runtime.tools.list()
  assert.ok(catalog.tools.some(tool => tool.name === 'exec'))
  assert.deepEqual(await f.calls(), [])
  await assert.rejects(stat(f.status.project), { code: 'ENOENT' })
  for (let i = 0; i < 2; i++) {
    const result = await f.runtime.tools.call('exec', { python: 'import sys; print(sys.executable)' }, { sessionID: 'python' })
    assert.ok(!result.isError, result.output)
    assert.equal(JSON.parse(result.output).output.trim(), f.status.executable)
    assert.equal((await f.calls()).length, 1)
  }
})

test('concurrent first use across runtimes waits for complete preparation, then reuses and recreates the environment', async t => {
  const f = await fixture(t)
  await f.configure({ gate: true })
  let completed = 0
  const first = f.launch().then(value => { completed++; return value })
  await until(async () => (await f.calls()).length === 1)
  assert.ok((await stat(f.status.executable)).isFile())
  const other = f.create()
  const followers = Array.from({ length: 5 }, () => f.launch(undefined, other).then(value => { completed++; return value }))
  await delay(50)
  assert.equal(completed, 0, 'an executable from an unfinished sync is not ready')
  await f.release()
  const results = await Promise.all([first, ...followers])
  assert.ok(results.every(value => value.executable === f.status.executable && value.present))
  assert.equal((await f.calls()).length, 1)
  await f.launch()
  assert.equal((await f.calls()).length, 1)
  await rm(f.status.venv, { recursive: true })
  await f.launch()
  assert.equal((await f.calls()).length, 2)
})

test('a failed bootstrap with a partial interpreter retries rather than declaring it ready', async t => {
  const f = await fixture(t)
  await f.configure({ fail: true })
  await assert.rejects(f.launch(), /test synchronization failed/)
  assert.ok((await stat(f.status.executable)).isFile())
  await f.configure({})
  await f.launch()
  await f.launch()
  assert.equal((await f.calls()).length, 2)
})

test('canceling a queued caller does not cancel preparation needed by other callers', async t => {
  const f = await fixture(t)
  await f.configure({ gate: true })
  const first = f.launch()
  await until(async () => (await f.calls()).length === 1)
  const canceled = new AbortController()
  const rejection = assert.rejects(f.launch(canceled.signal), /waiter canceled/)
  const survivor = f.launch()
  canceled.abort(new Error('waiter canceled'))
  await rejection
  await f.release()
  await Promise.all([first, survivor])
  assert.equal((await f.calls()).length, 1)
})

test('canceling the preparing caller stops its process and lets another runtime retry', async t => {
  const f = await fixture(t)
  await f.configure({ gate: true })
  const canceled = new AbortController()
  const rejection = assert.rejects(f.launch(canceled.signal), /owner canceled/)
  await until(async () => (await f.calls()).length === 1)
  const [{ pid }] = await f.calls()
  const survivor = f.launch(undefined, f.create())
  await f.configure({})
  canceled.abort(new Error('owner canceled'))
  await rejection
  await survivor
  assert.equal((await f.calls()).length, 2)
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
})

test('explicit preparation synchronizes existing environments and execution waits for it', async t => {
  const f = await fixture(t)
  await f.existing()
  await f.configure({ gate: true })
  const explicit = f.runtime.python.prepare()
  await until(async () => (await f.calls()).length === 1)
  let finished = false
  const execution = f.launch().then(() => { finished = true })
  await delay(50)
  assert.equal(finished, false)
  await f.release()
  await Promise.all([explicit, execution])
  await f.runtime.python.prepare()
  await f.launch()
  assert.equal((await f.calls()).length, 2)
})

test('missing imports report the interpreter without synchronization or replay', async t => {
  const f = await fixture(t)
  await f.existing()
  const tool = await f.tool('from pathlib import Path\nwith Path("attempts").open("a") as f: f.write("attempt\\n")\nimport kinex_dependency_that_does_not_exist\n')
  const result = await f.runtime.tools.call('probe', {}, { sessionID: 'python' })
  assert.equal(result.isError, true)
  assert.match(result.output, /kinex_dependency_that_does_not_exist/)
  assert.ok(result.output.includes(f.status.executable))
  assert.equal(await readFile(path.join(tool, 'attempts'), 'utf8'), 'attempt\n')
  assert.deepEqual(await f.calls(), [])
})

test('explicit tool interpreters bypass default environment preparation', async t => {
  const f = await fixture(t)
  await f.tool(undefined, python)
  const result = await f.runtime.tools.call('probe', {}, { sessionID: 'python' })
  assert.ok(!result.isError, result.output)
  assert.equal(JSON.parse(result.output).python, python)
  await assert.rejects(stat(f.status.project), { code: 'ENOENT' })
  assert.deepEqual(await f.calls(), [])
})

test('default persistent and one-shot drivers use the prepared interpreter without syncing', async t => {
  const f = await fixture(t)
  await f.existing()
  await f.runtime.profiles.writeManifest({ identity: { id: 'python', name: 'Python', kind: 'arm', platform: 'real' } })
  for (const persistent of [true, false]) {
    const name = persistent ? 'persistent' : 'oneshot'
    await f.runtime.profiles.writeDevice({ name, type: 'other', loaded: false,
      access: { connection: { kind: 'process' }, driver: {
        entry: 'driver.py', persistent, actions: ['load', 'unload', 'status', 'read'], timeout_s: 5,
      } },
    })
    await writeFile(path.join(f.directory, '.kinex/devices', name, 'driver.py'),
      'import os, sys\nfrom kinex.driver_protocol import run\nrun(lambda action, args: {"ok": True, "python": sys.executable, "pid": os.getpid()}, lambda: None)\n')
    await (await f.runtime.devices.load(name)).ready
    const first = await f.runtime.devices.dispatch(name, 'read')
    const second = await f.runtime.devices.dispatch(name, 'read')
    assert.equal(first.data.python, f.status.executable)
    assert.equal(second.data.python, f.status.executable)
    if (persistent) assert.equal(first.data.pid, second.data.pid)
    await f.runtime.devices.unload(name)
  }
  assert.deepEqual(await f.calls(), [])
})

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import path from 'node:path'
import { isolate, fakeProvider, workspace, seed } from './helpers.mjs'

const isolation = await isolate()
after(isolation.cleanup)
const { createKinexRuntime } = await import('@kinex/core')
const entry = fileURLToPath(new URL('../bin/kinex.mjs', import.meta.url))

for (const [signal, exitCode] of [['SIGTERM', 143], ['SIGINT', 130]]) {
  test(`${signal} closes live drivers and finalizes recording during an active model request`, { timeout: 15000 }, async t => {
    const cwd = await workspace(t)
    const fake = await fakeProvider(t, isolation.root)
    let release
    fake.steps.push({ wait: new Promise(resolve => { release = resolve }) })
    t.after(() => release())
    const core = createKinexRuntime({ directory: cwd })
    await seed(core)
    await core.profiles.writeDevice({ name: 'sensor', loaded: true, access: {
      connection: { kind: 'process' }, driver: {
        interpreter: 'python3', persistent: true, actions: ['load', 'unload', 'read', 'status'], timeout_s: 2,
      },
    } })
    const device = path.join(cwd, '.kinex/devices/sensor')
    await writeFile(path.join(device, 'driver.py'), `import os
from kinex.driver_protocol import run
def dispatch(action, args):
    with open("pid", "w") as output: output.write(str(os.getpid()))
    return {"ok": True, "value": 1}
def close():
    with open("closed", "w") as output: output.write(str(os.getpid()))
run(dispatch, close)
`)
    await core.dispose()
    const child = spawn(process.execPath, [entry, 'run', '--auto', '--model', 'fake/test', '--record', 'sensor=2', 'Wait for shutdown'], { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stdout.resume()
    child.stderr.on('data', data => { stderr += data })
    const exited = once(child, 'exit')
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
    // Startup can include Python initialization on a busy filesystem.
    for (let attempt = 0; attempt < 400 && !fake.requests.length && child.exitCode === null; attempt++) await delay(25)
    assert.equal(fake.requests.length, 1, stderr)
    const pid = await readFile(path.join(device, 'pid'), 'utf8')
    child.kill(signal)
    assert.deepEqual(await exited, [exitCode, null], stderr)
    assert.equal(await readFile(path.join(device, 'closed'), 'utf8'), pid)
    assert.throws(() => process.kill(Number(pid), 0), { code: 'ESRCH' })
    const reader = createKinexRuntime({ directory: cwd })
    t.after(() => reader.dispose())
    const recordings = await reader.recording.recent()
    assert.equal(recordings.length, 1)
    assert.equal(recordings[0].status, 'stopped')
  })
}

for (const [specs, json] of [['sensor=2', false], ['sensor=2 camera=2', true], ['camera=2', true]]) {
  test(`headless --record ${specs} reports refusals and continues the model task (json=${json})`, { timeout: 15000 }, async t => {
    const cwd = await workspace(t)
    const fake = await fakeProvider(t, isolation.root)
    const core = createKinexRuntime({ directory: cwd })
    await seed(core)
    await core.profiles.writeDevice({ name: 'sensor', loaded: true })
    await core.dispose()

    const reader = createKinexRuntime({ directory: cwd })
    t.after(() => reader.dispose())
    let statusDuringTask
    fake.respond = async () => {
      statusDuringTask = (await reader.recording.recent())[0]?.status
      return { text: 'TASK_COMPLETED' }
    }
    const child = spawn(process.execPath, [entry, 'run', '--auto', '--model', 'fake/test',
      '--record', specs, ...(json ? ['--json'] : []), 'Read the sensors'], { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', data => { stdout += data })
    child.stderr.on('data', data => { stderr += data })
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
    const [code] = await once(child, 'close')
    assert.equal(code, 0, stderr)
    if (specs.includes('camera=')) assert.match(stderr, /--record refused: camera: no device "camera" in this workspace/)
    else assert.equal(stderr, '')
    if (json) for (const line of stdout.trim().split('\n')) assert.doesNotThrow(() => JSON.parse(line))
    assert.match(stdout, /TASK_COMPLETED/)
    assert.equal(fake.requests.length, 1)
    const hasValidDevice = specs.includes('sensor=')
    assert.equal(statusDuringTask, hasValidDevice ? 'recording' : 'stopped')

    const recordings = await reader.recording.recent()
    assert.equal(recordings.length, 1)
    assert.equal(recordings[0].status, 'stopped')
    assert.deepEqual(Object.keys(recordings[0].sampling.devices), hasValidDevice ? ['sensor'] : [])
  })
}

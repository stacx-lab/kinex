import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { copyFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const globals = await mkdtemp(path.join(os.tmpdir(), 'kinex-wait-home-'))
process.env.KINEX_CONFIG_DIR = path.join(globals, 'config')
process.env.KINEX_DATA_DIR = path.join(globals, 'data')
after(() => rm(globals, { recursive: true, force: true }))
const { createKinexRuntime } = await import('../dist/index.js')

async function fixture(t, behavior = {}, timeout_s = .4) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kinex-wait-'))
  const runtime = createKinexRuntime({ directory, host: { ask: async () => {} } })
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  await runtime.profiles.writeManifest({ identity: { id: 'wait-test', name: 'Wait test', platform: 'real', kind: 'arm' } })
  await runtime.profiles.writeDevice({ name: 'world', type: 'world', loaded: false,
    access: { connection: { kind: 'process' }, driver: {
      interpreter: 'python3', persistent: true, timeout_s: 5,
      actions: ['load', 'unload', 'status', 'read', 'wait'],
    } } })
  const device = path.join(directory, '.kinex/devices/world')
  await copyFile(new URL('./fixtures/world-wait-driver.py', import.meta.url), path.join(device, 'driver.py'))
  await writeFile(path.join(device, 'behavior.json'), JSON.stringify(behavior))
  await (await runtime.devices.load('world')).ready
  await runtime.profiles.writeDevice({ name: 'world', access: { driver: { timeout_s } } })
  const status = async () => (await runtime.devices.ping('world')).reading.data
  return { runtime, directory, status, pid: (await status()).pid }
}

async function until(status, predicate) {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    if (predicate(await status())) return
    await delay(10)
  }
  assert.fail('driver did not reach the expected state')
}

function timeout(error) {
  assert.equal(error.name, 'DriverError')
  assert.match(error.message, /world wait timed out/)
  assert.deepEqual(error.data, { code: 'wait_timeout' })
  return true
}

test('world wait deadlines drain either reply order and preserve concurrent calls', async t => {
  for (const behavior of [{ reply_delay: .2 }, { reply_first: true, ack_delay: 1.1, late_success: true }]) {
    await t.test(JSON.stringify(behavior), async t => {
      const { runtime, status, pid } = await fixture(t, behavior, behavior.ack_delay ? 1.5 : .4)
      const rejected = assert.rejects(runtime.devices.dispatch('world', 'wait', { duration_s: 30 }), timeout)
      await until(status, value => value.interrupts === 1)
      assert.ok((await runtime.devices.dispatch('world', 'wait', { duration_s: .05 })).data.waited_s >= .05)
      await rejected
      assert.ok(Number.isFinite((await runtime.devices.dispatch('world', 'read')).data.time_s))
      assert.equal((await status()).pid, pid)
      assert.equal((await status()).interrupts, 1)
      assert.equal((await runtime.profiles.snapshot()).devices[0].loaded, true)
      await runtime.devices.dispatch('world', 'wait', { duration_s: .01 })
    })
  }
})

test('wait_timeout survives direct tools and Python RPC without elapsed time', async t => {
  const { runtime, directory, status, pid } = await fixture(t)
  const tool = path.join(directory, '.kinex/tool/wait_probe')
  await mkdir(tool, { recursive: true })
  await writeFile(path.join(tool, 'tool.yaml'), 'name: wait_probe\nkind: controller\ndescription: Wait timeout probe\ninterpreter: python3\ntimeout_s: 10\nparameters: {type: object}\n')
  await writeFile(path.join(tool, 'tool.py'), 'from kinex import device\ndevice("world", "wait", duration_s=30)\n')
  for (const [name, args] of [['device', { deviceID: 'world', action: 'wait', args: { duration_s: 30 } }], ['wait_probe', {}]]) {
    const result = await runtime.tools.call(name, args, { sessionID: 'timeout-test' })
    assert.equal(result.isError, true, result.output)
    assert.match(result.output, /wait_timeout/)
    const failure = JSON.parse(result.output)
    assert.deepEqual(Object.keys(failure).sort(), ['code', 'error'])
    assert.equal(failure.code, 'wait_timeout')
    assert.match(failure.error, /world wait timed out/)
    assert.equal((await status()).pid, pid)
  }
})

test('caller abort and deadline share one world wait cancellation', async t => {
  for (const abortFirst of [true, false]) {
    await t.test(abortFirst ? 'abort first' : 'deadline first', async t => {
      const { runtime, status, pid } = await fixture(t, { reply_first: true, ack_delay: .3 })
      const controller = new AbortController()
      const rejected = assert.rejects(runtime.devices.dispatch('world', 'wait', { duration_s: 30 }, controller.signal), /caller cancelled/)
      await until(status, value => abortFirst ? value.waiting === 1 : value.interrupts === 1)
      if (abortFirst) await delay(200)
      controller.abort(new Error('caller cancelled'))
      await rejected
      // A lifecycle fence waits for cancellation recovery, including the delayed acknowledgement.
      await (await runtime.devices.load('world')).ready
      assert.equal((await status()).pid, pid)
      assert.equal((await status()).interrupts, 1)
      await runtime.devices.dispatch('world', 'wait', { duration_s: .01 })
    })
  }
})

test('failed world wait cancellation terminates the driver within its recovery budget', async t => {
  for (const mode of ['missing_ack', 'missing_completion', 'reject', 'exit']) await t.test(mode, async t => {
    const { runtime, pid } = await fixture(t, { [mode]: true })
    const started = Date.now()
    await assert.rejects(runtime.devices.dispatch('world', 'wait', { duration_s: 30 }), error => {
      assert.equal(error.name, 'DriverError')
      assert.notEqual(error.data.code, 'wait_timeout')
      assert.match(error.message, /cancellation.*load the device/)
      return true
    })
    assert.ok(Date.now() - started < 3000)
    assert.equal((await runtime.devices.ping('world')).serving, false)
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
    await assert.rejects(runtime.devices.dispatch('world', 'read'), /inactive/)
    assert.equal((await runtime.profiles.snapshot()).devices[0].loaded, true)
  })
})

test('non-wait deadlines remain fatal and disposal closes a recovering world driver', async t => {
  const failed = await fixture(t, { hang_read: true })
  await assert.rejects(failed.runtime.devices.dispatch('world', 'read'), /persistent driver timed out/)
  assert.equal((await failed.runtime.devices.ping('world')).serving, false)
  const { runtime, status, pid } = await fixture(t, { ack_delay: .3 })
  const rejected = assert.rejects(runtime.devices.dispatch('world', 'wait', { duration_s: 30 }), /disposed/)
  await until(status, value => value.interrupts === 1)
  await runtime.dispose()
  await rejected
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { scheduleDevice } from '../dist/device/scheduler.js'

test('stop prevents a prepared command from reaching the device after asynchronous setup', async () => {
  const ready = Promise.withResolvers()
  const prepared = Promise.withResolvers()
  const effects = []
  const write = scheduleDevice('preparing', 'write', async ({ check }) => {
    ready.resolve()
    await prepared.promise
    check()
    effects.push('write')
  })
  const rejected = assert.rejects(write, /interrupted/)
  await ready.promise
  await scheduleDevice('preparing', 'stop', async () => { effects.push('stop') })
  prepared.resolve()
  await rejected
  assert.deepEqual(effects, ['stop'])
  await scheduleDevice('preparing', 'write', async ({ check }) => { check(); effects.push('new write') })
  assert.deepEqual(effects, ['stop', 'new write'])
})

import { test } from 'node:test'
import { useUv } from './fixtures/python.mjs'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createKinexRuntime } from '../dist/index.js'
import { protocolDevice, protocolFramePython } from './fixtures/protocol.mjs'

test('one Python runtime serves a domain\'s programs across device loads, and a program that will not end takes it down', {timeout: 30000}, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kinex-runtime-owner-'))
  await useUv(path.join(directory, '.kinex'))
  const runtime = createKinexRuntime({directory})
  t.after(async () => { await runtime.dispose(); await rm(directory, {recursive:true, force:true}) })
  await runtime.profiles.writeManifest({identity:{id:'frames',name:'Frames',kind:'other'}})
  await protocolFramePython(runtime)
  await protocolDevice(runtime, directory, 'sensor')
  const program = async (python, options = {}) => {
    const result = await runtime.tools.call('exec', {python, ...options}, {sessionID:'runtime',ask:async()=>{}})
    return {...JSON.parse(result.output), isError: result.isError}
  }
  const pid = 'import os\nfrom kinex import finish\nfinish(os.getpid())'
  // A program leaves nothing behind for the next: neither its modules' state nor its names.
  const first = (await program('import os, sys\nfrom kinex import finish\nsys.modules["__main__"].kept = 1\nvalue = 1\nfinish(os.getpid())')).result
  assert.equal((await program('import os, sys\nfrom kinex import finish\nassert "value" not in globals() and not hasattr(sys.modules["__main__"], "kept")\nfinish(os.getpid())')).result, first)
  await (await runtime.devices.load('sensor')).ready
  assert.equal((await program(pid)).result, first)
  await runtime.devices.unload('sensor')
  assert.equal((await program(pid)).result, first)
  // A program that ignores its cancellation is killed with its runtime; the next one gets another.
  const stuck = await program('import time\ntime.sleep(30)', {timeout_s: 1})
  assert.equal(stuck.isError, true)
  assert.match(stuck.error, /exec timed out/)
  assert.throws(() => process.kill(first, 0), {code:'ESRCH'})
  const second = (await program(pid)).result
  assert.notEqual(second, first)
  await runtime.dispose()
  assert.throws(() => process.kill(second, 0), {code:'ESRCH'})
})

test('a device follows the clock of the world in its own ROS domain', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kinex-runtime-domain-'))
  await useUv(path.join(directory, '.kinex'))
  const runtime = createKinexRuntime({directory})
  t.after(async () => {await runtime.dispose(); await rm(directory,{recursive:true,force:true})})
  await runtime.profiles.writeManifest({identity:{id:'frames',name:'Frames',kind:'other'}})
  await protocolFramePython(runtime)
  // A world keeps its domain's /clock, which is not one of its operations.
  await protocolDevice(runtime, directory, 'alpha', {type:'world'})
  await runtime.profiles.writeDevice({name:'alpha', runtime:{domain_id:7}})
  await protocolDevice(runtime, directory, 'sensor', {loaded:true})
  await protocolDevice(runtime, directory, 'remote')
  await runtime.profiles.writeDevice({name:'remote', runtime:{domain_id:7}})
  await (await runtime.devices.load('remote')).ready
  const clock = async name => (await readFile(path.join(directory,'.kinex/devices',name,'events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse)
    .find(event => event.action === 'load').args.clock
  assert.equal(await clock('sensor'), undefined)
  assert.deepEqual([(await clock('remote')).endpoint, (await clock('remote')).type], ['/clock', 'rosgraph_msgs/msg/Clock'])
})

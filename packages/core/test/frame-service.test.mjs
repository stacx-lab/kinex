import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createKinexRuntime } from '../dist/index.js'
import { protocolDevice, protocolFramePython } from './fixtures/protocol.mjs'

test('Kinex owns one frame service across devices and exec turns outside the catalog', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kinex-frames-owner-'))
  const runtime = createKinexRuntime({directory})
  t.after(async () => { await runtime.dispose(); await rm(directory, {recursive:true, force:true}) })
  await runtime.profiles.writeManifest({identity:{id:'frames',name:'Frames',kind:'other'}})
  await protocolFramePython(runtime)
  await protocolDevice(runtime, directory, 'world', { type:'world',
operations:{time:{ description:'Clock',
transport:'topic',
direction:'output',
endpoint:'/clock',
type:'rosgraph_msgs/msg/Clock' }},
frames: {...{base: {parent: null, translation_m: null, rotation_xyzw: null}}} })
  await protocolDevice(runtime, directory, 'sensor')
  await Promise.all(['world', 'sensor'].map(async name => (await runtime.devices.load(name)).ready))
  const events = async () => (await readFile(path.join(directory,'.kinex','events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal((await events()).filter(event => event.action === '$frames').length, 1)
  const snapshot = async () => {
    const result = await runtime.tools.call('exec', {python:'from kinex import _request, finish\nfinish(_request["ros"]["frames"])'}, {
      sessionID:'frames',ask:async()=>{},
    })
    assert.ok(!result.isError, result.output)
    return JSON.parse(result.output).result
  }
  const first = await snapshot()
  assert.equal(first.type, 'kinex_interfaces/srv/LookupTransform')
  assert.match(first.endpoint, /^\/kinex\/internal\/f_/)
  await runtime.devices.unload('sensor')
  assert.deepEqual(await snapshot(), first)
  await (await runtime.devices.load('sensor')).ready
  assert.deepEqual(await snapshot(), first)
  assert.deepEqual(Object.keys((await runtime.devices.operations()).find(d=>d.name==='world').operations), ['time'])
  assert.ok((await events()).some(event=>event.action==='$frame_device' && event.args.name==='sensor' && !event.args.active))
  await protocolDevice(runtime, directory, 'broken', {handler:`def dispatch(action,args,owner,cancelled):
    if action == 'load': raise RuntimeError('device startup failed')
    return {'ready': True}
`})
  await assert.rejects(async () => (await runtime.devices.load('broken')).ready, /device startup failed/)
  assert.ok((await events()).some(event=>event.action==='$frame_device' && event.args.name==='broken' && !event.args.active))
  await runtime.dispose()
  const pid = Number(await readFile(path.join(directory,'.kinex','closed'),'utf8'))
  assert.throws(()=>process.kill(pid,0), {code:'ESRCH'})
})


test('frame service startup failure is reaped and an explicit reload can recover', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kinex-frames-retry-'))
  const runtime = createKinexRuntime({directory})
  t.after(async () => {await runtime.dispose(); await rm(directory,{recursive:true,force:true})})
  await runtime.profiles.writeManifest({identity:{id:'frames',name:'Frames',kind:'other'}})
  await protocolFramePython(runtime)
  await protocolDevice(runtime,directory,'world',{ type:'world',
operations:{time:{ description:'Clock',
transport:'topic',
direction:'output',
endpoint:'/clock',
type:'rosgraph_msgs/msg/Clock' }},
frames: {...{base: {parent: null, translation_m: null, rotation_xyzw: null}}} })
  await writeFile(path.join(directory,'.kinex','handler.py'), `from pathlib import Path
import os
def dispatch(action, args, owner, cancelled):
    Path('frame.pid').write_text(str(os.getpid()))
    if action == '$frames' and not Path('allow').exists():
        raise RuntimeError('frame startup failed')
    return {'ready': True}
`)
  await assert.rejects(async () => (await runtime.devices.load('world')).ready, /frame startup failed/)
  const pid = Number(await readFile(path.join(directory,'.kinex','frame.pid'),'utf8'))
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'})
  await writeFile(path.join(directory,'.kinex','allow'),'')
  await (await runtime.devices.reload('world')).ready
  assert.equal((await runtime.devices.ping('world')).serving,true)
})

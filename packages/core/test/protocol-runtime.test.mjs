import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, access } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createKinexRuntime, PermissionDeniedError } from '../dist/index.js'
import { Device } from '../dist/device/profile/schema.js'
import { Operation } from '../dist/device/profile/operations.js'
import { coreContribution } from '../dist/integration.js'
import { protocolDevice, inputOperation, outputOperation } from './fixtures/protocol.mjs'

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(),'kinex-protocol-'))
  const runtime = createKinexRuntime({directory,host:{ask:async()=>{}},...options})
  t.after(async()=>{await runtime.dispose(); await rm(directory,{recursive:true,force:true})})
  await runtime.profiles.writeManifest({identity:{id:'protocol',name:'Protocol',kind:'other'}})
  const python=(await runtime.python.status()).executable
  await mkdir(path.dirname(python),{recursive:true})
  await symlink(execFileSync('python3',['-c','import sys;print(sys.executable)'],{encoding:'utf8'}).trim(),python)
  return {runtime,directory}
}
const exec = (runtime, python, extra={}) => runtime.tools.call('exec',{python},{sessionID:'test',...extra})
const events = async dir => (await readFile(path.join(dir,'events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse)

test('device and operation descriptions are required strings and accept empty text',()=>{
 const base={ name:'device',
   type:'other',
   meta:{created_at:'',updated_at:''},
   frames: { base: {parent: null, translation_m: null, rotation_xyzw: null} } }
 assert.throws(()=>Device.parse(base),/description/)
 assert.equal(Device.parse({...base,description:''}).description,'')
 for(const value of [null,42]) assert.throws(()=>Device.parse({...base,description:value}),/description/)
 const op=outputOperation();delete op.description
 assert.throws(()=>Operation.parse(op),/description/)
 assert.equal(Operation.parse({...op,description:''}).description,'')
 assert.throws(()=>Device.parse({...base,description:'',access:{extra:true}}),/extra/)
})

test('descriptions are discovered unloaded without ROS imports; type does not determine operations',async t=>{
 const {runtime,directory}=await fixture(t)
 for(const [name,operation] of [['one','temperature'],['two','distance']])
   await runtime.profiles.writeDevice({ name,
     type:'other',
     description:`General ${name}`,
     loaded:false,
     runtime:{interpreter:'/never/start'},
     operations:{[operation]:{...outputOperation(operation),description:`Operation ${name}`}},
     frames: { base: {parent: null, translation_m: null, rotation_xyzw: null} } })
 const result=await exec(runtime,`import sys
from kinex import runtime, finish
assert 'rclpy' not in sys.modules
one=runtime.device('one')
assert 'rclpy' not in sys.modules
finish({'device':one,'ops':runtime.operations('two'),'devices':runtime.devices()})`)
 assert.ok(!result.isError,result.output)
 const value=JSON.parse(result.output).result
 assert.deepEqual(value.device,{name:'one',type:'other',description:'General one',loaded:false,ready:false})
 assert.deepEqual(Object.keys(value.ops),['distance'])
 assert.ok(value.devices.every(d=>!('description' in d)))
 const before=await coreContribution(runtime).context()
 await runtime.profiles.writeDevice({name:'one',description:'Changed description'})
 const after=await coreContribution(runtime).context()
 assert.deepEqual(after,before)
 assert.doesNotMatch(JSON.stringify(after),/General one|Operation one|Changed description/)
 await assert.rejects(access(path.join(directory,'.kinex/devices/one/events.jsonl')))
})

test('devices without a runtime and invalid profiles fail with actionable diagnostics',async t=>{
 const {runtime,directory}=await fixture(t)
 await runtime.profiles.writeDevice({ name:'old',
   type:'other',
   description:'',
   loaded:true,
   frames: { base: {parent: null, translation_m: null, rotation_xyzw: null} } })
 await assert.rejects(runtime.devices.dispatch('old','status'),/configure runtime.nodes and operations/)
 await assert.rejects(runtime.devices.dispatch('old','read'),/unknown operation old.read/)
 const file=path.join(directory,'.kinex/devices/old/profile.yaml')
 await writeFile(file,"name: old\ntype: other\naccess: {extra: true}\n")
 await assert.rejects(runtime.devices.list(),/top-level facts and frames.base/)
})

test('host startup, out-of-order results, cancellation and reload preserve operation identity',async t=>{
 const {runtime,directory}=await fixture(t)
 const dir=await protocolDevice(runtime,directory)
 assert.equal((await runtime.devices.ping('sensor')).reading.data.ready,false)
 const loading=await runtime.devices.load('sensor');await loading.ready
 const slow=runtime.devices.dispatch('sensor','read',{sleep:.2,value:2})
 const fast=await runtime.devices.dispatch('sensor','read',{value:3,noisy:true})
 assert.equal(fast.data.value,3);assert.equal((await slow).data.value,2)
 await assert.rejects(runtime.devices.dispatch('sensor','read',{sleep:2},AbortSignal.timeout(40)))
 assert.equal((await runtime.devices.dispatch('sensor','read')).data.value,1)
 const pid=fast.data.pid
 await (await runtime.devices.reload('sensor')).ready
 assert.notEqual((await runtime.devices.dispatch('sensor','read')).data.pid,pid)
 assert.throws(()=>process.kill(pid,0),{code:'ESRCH'})
 await runtime.dispose()
 assert.ok((await events(dir)).some(e=>e.action==='unload'))
})

test('batch preauthorization and validation precede dispatch',async t=>{
 const {runtime,directory}=await fixture(t)
 const dir=await protocolDevice(runtime,directory,'sensor',{loaded:true})
 const before=(await events(dir)).length
 await assert.rejects(runtime.tools.call('devices',{calls:[{deviceID:'sensor',action:'read'},{deviceID:'sensor',action:'write'}]},
 {sessionID:'test',ask:async({permission})=>{if(permission==='device_act')throw new PermissionDeniedError(permission)}}),PermissionDeniedError)
 assert.equal((await events(dir)).length,before)
 const invalid=await runtime.tools.call('device',{deviceID:'sensor',action:'invented'},{sessionID:'test'})
 assert.equal(invalid.isError,true)
 assert.equal((await events(dir)).length,before)
 const batch=await runtime.tools.call('devices',{calls:[{deviceID:'sensor',action:'read'},{deviceID:'missing',action:'read'}]},{sessionID:'test'})
 const results=JSON.parse(batch.output).results
 assert.equal(results[0].ok,true);assert.equal(results[1].ok,false)
})

// io enrolls a device this way before its first command.
const enroll = "_rpc({'call':'ros_enroll','device':'sensor'})"
const stops = async dir => (await events(dir)).filter(e=>e.action==='stop').length

for(const mode of ['success','failure','cancel']) test(`a commanded device is stopped only when the invocation fails (${mode})`,async t=>{
 const approvals=[]
 const {runtime,directory}=await fixture(t,{host:{ask:async p=>approvals.push(p.permission)}})
 const dir=await protocolDevice(runtime,directory,'sensor',{loaded:true})
 const tail=mode==='failure'?"raise RuntimeError('task failed')":mode==='cancel'?'import time;time.sleep(10)':"finish({'ok':True})"
 const result=await exec(runtime,`from kinex import _rpc, finish\n${enroll}\n${tail}`,mode==='cancel'?{signal:AbortSignal.timeout(500)}:{})
 assert.equal(!!result.isError,mode!=='success',result.output)
 assert.deepEqual(approvals,['python_tool'])
 assert.equal(await stops(dir),mode==='success'?0:1)
})

// device_stop, a device call's stop action and the runtime dispatch share invocation cancellation.
const stoppers={
 device_stop:(runtime,deviceID)=>runtime.tools.call('device_stop',{deviceID},{sessionID:'stop'}),
 device:(runtime,deviceID)=>runtime.tools.call('device',{deviceID,action:'stop'},{sessionID:'stop'}),
 dispatch:(runtime,deviceID)=>runtime.devices.dispatch(deviceID,'stop').then(()=>({})),
}
for(const [via,stop] of Object.entries(stoppers)) test(`a device stop cancels only the invocations that commanded it (${via})`,async t=>{
 const {runtime,directory}=await fixture(t)
 const dir=await protocolDevice(runtime,directory,'sensor',{loaded:true})
 await protocolDevice(runtime,directory,'idle',{loaded:true})
 const marker=path.join(directory,'enrolled')
 let finished=false
 const running=exec(runtime,`from kinex import _rpc\n${enroll}\nopen(${JSON.stringify(marker)},'w').close()\nimport time;time.sleep(30)`)
 void running.then(()=>{finished=true})
 while(!await access(marker).then(()=>true,()=>false)) await delay(20)
 assert.ok(!(await stop(runtime,'idle')).isError)
 await delay(200)
 assert.equal(finished,false)
 assert.ok(!(await stop(runtime,'sensor')).isError)
 const result=await running
 assert.equal(result.isError,true);assert.match(result.output,/device stop cancelled this invocation/)
 assert.equal(await stops(dir),2)
})

test('separate runtimes own separate node processes and disposal does not close the other',async t=>{
 const {runtime:a,directory}=await fixture(t)
 await protocolDevice(a,directory,'sensor',{loaded:true})
 const b=createKinexRuntime({directory});t.after(()=>b.dispose())
 await (await b.devices.load('sensor')).ready
 const pa=(await a.devices.dispatch('sensor','read')).data.pid
 const pb=(await b.devices.dispatch('sensor','read')).data.pid
 assert.notEqual(pa,pb)
 await a.dispose();assert.throws(()=>process.kill(pa,0),{code:'ESRCH'})
 assert.equal((await b.devices.dispatch('sensor','read')).data.pid,pb)
 await b.dispose()
})

test('a timed-out invocation stops its commanded device once',async t=>{
 const {runtime,directory}=await fixture(t)
 const dir=await protocolDevice(runtime,directory,'sensor',{loaded:true})
 const result=await runtime.tools.call('exec',{timeout_s:1,python:`import kinex
kinex.${enroll}
import time; time.sleep(10)`},{sessionID:'timeout'})
 assert.equal(result.isError,true);assert.match(result.output,/timed out|timeout/i)
 assert.equal(await stops(dir),1)
})

test('failed startup reports the device, rolls back its host and requires explicit reload',async t=>{
 const {runtime,directory}=await fixture(t)
 const dir=await protocolDevice(runtime,directory,'sensor',{handler:`def dispatch(action,args,cancelled):\n    raise RuntimeError('startup fixture failure')\n`})
 const activation=await runtime.devices.load('sensor')
 await assert.rejects(activation.ready,/startup fixture failure/)
 assert.equal((await runtime.devices.ping('sensor')).reading.data.ready,false)
 await assert.rejects(runtime.devices.dispatch('sensor','read'),/requires explicit load/)
 await writeFile(path.join(dir,'handler.py'),"def dispatch(action,args,cancelled):\n    return {'ready':True}\n")
 await (await runtime.devices.reload('sensor')).ready
 assert.equal((await runtime.devices.ping('sensor')).reading.data.ready,true)
})


test('public sample and cleanup names remain ordinary declared operations',async t=>{
 const {runtime,directory}=await fixture(t)
 const dir=await protocolDevice(runtime,directory,'sensor',{loaded:true,operations:{
   sample:outputOperation('sample'),cleanup:inputOperation('cleanup'),
 }})
 for(const action of ['sample','cleanup']) {
   const result=await runtime.tools.call('device',{deviceID:'sensor',action},{sessionID:'test'})
   assert.ok(!result.isError,result.output)
 }
 assert.deepEqual((await events(dir)).slice(-2).map(e=>e.action),['sample','cleanup'])
})

test('device reads attach PNG, JPEG, GIF and WebP captures in call order', async t => {
 const {runtime,directory}=await fixture(t)
 const images={png:'89504e470d0a1a0a',jpg:'ffd8ffe000104a46',gif:'474946383961',webp:'52494646000000005745425056503820'}
 for (const [format,bytes] of Object.entries(images)) {
  const file=path.join(directory,`frame.${format}`)
  await writeFile(file,Buffer.from(bytes,'hex'))
  await protocolDevice(runtime,directory,format,{loaded:true,handler:`def dispatch(action, args, cancelled):\n    return {'file': ${JSON.stringify(file)}, 'ready': True}\n`})
 }
 await writeFile(path.join(directory,'notes.txt'),'not an image')
 await protocolDevice(runtime,directory,'text',{loaded:true,handler:`def dispatch(action, args, cancelled):\n    return {'file': ${JSON.stringify(path.join(directory,'notes.txt'))}, 'ready': True}\n`})
 const single=await runtime.tools.call('device',{deviceID:'jpg',action:'read'},{sessionID:'images'})
 assert.deepEqual(single.attachments,[{mime:'image/jpeg',path:path.join(directory,'frame.jpg')}])
 const batch=await runtime.tools.call('devices',{calls:['webp','gif','png','text'].map(deviceID=>({deviceID,action:'read'}))},{sessionID:'images'})
 assert.deepEqual(batch.attachments.map(attachment=>attachment.mime),['image/webp','image/gif','image/png'])
 assert.equal(JSON.parse(batch.output).results[3].file,path.join(directory,'notes.txt'))
})

import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'

test('ROS onboarding directs authors to device and operation descriptions and owned factories',async()=>{
 const guide=await readFile(new URL('../assets/builtin/skill/onboard-ros2/SKILL.md',import.meta.url),'utf8')
 for(const term of ['runtime.nodes','runtime.device','runtime.describe','description','Kinex Python','borrowed']) assert.ok(guide.includes(term),term)
 assert.doesNotMatch(guide,/driver_protocol|profile_ros.yaml/)
})

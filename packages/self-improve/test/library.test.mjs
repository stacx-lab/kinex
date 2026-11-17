import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { check, createLibrary, install, installedBrief, newestVersion, publish, versions } from '../dist/library.js'
import { collect, renderStatus, scan, writeRecord } from '../dist/records.js'
import { writeTranscript } from '../dist/transcript.js'
import { openJob, finishJob, start, wait, isRunning, resultOf, spaced } from '../dist/job.js'
import { trialsDir, distillationsDir } from '../dist/layout.js'
import { judged } from '../dist/trial.js'
import { reference } from '../dist/distill.js'

async function directory(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'kinex-self-improve-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}
const put = async (file, text) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text) }
const skill = (name, description = 'does a thing') => `---\nname: ${name}\ndescription: ${description}\n---\nText.\n`

test('the check reports what Kinex could not load, and only a clean candidate is published', async t => {
  const root = await directory(t)
  assert.equal(await createLibrary(root), 'L0')
  const candidate = path.join(root, 'candidate')
  await put(path.join(candidate, 'payload/skills/good/SKILL.md'), skill('good'))
  await put(path.join(candidate, 'payload/skills/unnamed/SKILL.md'), 'No frontmatter.\n')
  await put(path.join(candidate, 'payload/skills/twin/SKILL.md'), skill('good'))
  await put(path.join(candidate, 'payload/skills/empty/notes.md'), 'x')
  await put(path.join(candidate, 'payload/tools/reach/tool.yaml'), 'name: reach\ndescription: Reach a pose\n')
  await put(path.join(candidate, 'payload/tools/bad/tool.yaml'), 'name: Bad Name\ndescription: x\nextra: 1\n')
  await put(path.join(candidate, 'payload/tools/bare/tool.py'), 'pass\n')
  await put(path.join(candidate, 'memory/EVIDENCE.md'), 'kept\n')
  const problems = await check(candidate)
  assert.deepEqual(problems.map(problem => problem.split(':')[0]).sort(), [
    'payload/skills/empty', 'payload/skills/twin/SKILL.md', 'payload/skills/unnamed/SKILL.md',
    'payload/tools/bad/tool.yaml', 'payload/tools/bare/tool.yaml', 'payload/tools/reach/tool.yaml',
  ])
  assert.deepEqual(await publish(root, candidate, { parent: 'L0', source: 'd001' }), { problems })
  assert.deepEqual(await versions(root), ['L0'])

  for (const name of ['unnamed', 'twin', 'empty']) await rm(path.join(candidate, 'payload/skills', name), { recursive: true })
  for (const name of ['bad', 'bare']) await rm(path.join(candidate, 'payload/tools', name), { recursive: true })
  await put(path.join(candidate, 'payload/tools/reach/tool.py'), 'def main(args):\n    return {}\n')
  await put(path.join(candidate, 'payload/brief.md'), 'Load good first.\n')
  assert.deepEqual(await publish(root, candidate, { parent: 'L0', source: 'd001' }), { problems: [], version: 'L1' })
  assert.equal(await newestVersion(root), 'L1')
  assert.equal(await readFile(path.join(root, 'libraries/L1/memory/EVIDENCE.md'), 'utf8'), 'kept\n')
  assert.deepEqual((await readdir(path.join(root, 'libraries'))).sort(), ['L0', 'L1'])

  await t.test('install copies the payload where Kinex discovers it and never overwrites', async () => {
    const workspace = path.join(root, 'workspace')
    await mkdir(workspace)
    assert.deepEqual(await install(path.join(root, 'libraries/L1'), workspace), { skills: ['good'], tools: ['reach'] })
    assert.equal(await readFile(path.join(workspace, '.kinex/skills/good/SKILL.md'), 'utf8'), skill('good'))
    assert.match(await readFile(path.join(workspace, '.kinex/tools/reach/tool.yaml'), 'utf8'), /name: reach/)
    assert.equal(await installedBrief(workspace), 'Load good first.')
    await assert.rejects(readFile(path.join(workspace, '.kinex/memory/EVIDENCE.md')), { code: 'ENOENT' })
    await assert.rejects(install(path.join(root, 'libraries/L1'), workspace), /Already present[\s\S]*skills\/good[\s\S]*tools\/reach/)
    assert.equal(await installedBrief(path.join(root, 'elsewhere')), '')
  })
})

test('the state of a run is read from its job folders', async t => {
  const root = await directory(t)
  await createLibrary(root)
  const trial = (task, library) => ({ task, robot: 'sim/arm', library, timeoutS: 60 })
  const failed = await openJob(trialsDir(root), 't', trial('sim/a', 'L0'))
  const solved = await openJob(trialsDir(root), 't', trial('sim/b', 'L0'))
  const abandoned = await openJob(trialsDir(root), 't', trial('sim/a', 'L0'))
  assert.deepEqual([failed.id, solved.id, abandoned.id], ['t001', 't002', 't003'])
  await finishJob(failed, { status: 'done', success: false, steps: 500, reason: 'max_steps', wallS: 30 })
  await finishJob(solved, { status: 'timeout', success: true, steps: 120, wallS: 60 })
  const distillation = await openJob(distillationsDir(root), 'd', { base: 'L0', trials: ['t001'], fresh: ['t001'], timeoutS: 60 })
  let status = await scan(root)
  assert.deepEqual(status.fresh, ['t001', 't002'])
  await finishJob(distillation, { status: 'done', problems: ['payload/skills/x: no SKILL.md'] })
  assert.deepEqual((await scan(root)).fresh, ['t001', 't002'], 'a distillation that published nothing has incorporated nothing')
  const second = await openJob(distillationsDir(root), 'd', { base: 'L0', trials: ['t001'], fresh: ['t001'], timeoutS: 60 })
  await finishJob(second, { status: 'done', problems: [], version: 'L1' })
  status = await scan(root)
  assert.deepEqual(status.fresh, ['t002'])
  const text = renderStatus(root, status, id => id === 't003')
  assert.match(text, /Tasks: 1\/2 solved/)
  assert.match(text, /- sim\/a \[UNSOLVED\] L0 0\/1\n- sim\/b \[solved\] L0 1\/1/)
  assert.match(text, /- t001, sim\/a, L0, failure, max_steps, 500 steps, 30 s/)
  assert.match(text, /- t002, sim\/b, L0, success \(timeout\), 120 steps, 60 s/)
  assert.match(text, /- t003, sim\/a, L0, running/)
  assert.match(renderStatus(root, status, () => false), /- t003, sim\/a, L0, abandoned/)
  assert.match(text, /- d001, base L0, 1 trials \(1 new\), published nothing \(check failed: payload\/skills\/x: no SKILL.md\)/)
  assert.match(text, /- d002, base L0, 1 trials \(1 new\), published L1/)
})

test('a judged episode makes a trial done, whatever the worker exited with', () => {
  const exit = { status: 'error', exitCode: 1, wallS: 9 }
  assert.deepEqual(judged(exit, { success: true, steps: 1699 }), { ...exit, status: 'done', note: 'worker exited 1; see output.log' })
  assert.deepEqual(judged(exit, { success: false }), { ...exit, status: 'done', note: 'worker exited 1; see output.log' })
  assert.deepEqual(judged(exit, { success: false, steps: 0 }), { ...exit, error: 'worker exited 1 before the simulation advanced; see output.log' })
  const timeout = { status: 'timeout', exitCode: 143, wallS: 3600 }
  assert.equal(judged(timeout, { success: false, steps: 0 }), timeout)
})

test('work starts within its limit, and waiting does not end it', async () => {
  const order = []
  const gates = {}
  const work = id => start(id, 'lane', 2, () => new Promise(resolve => { order.push(id); gates[id] = () => resolve({ status: 'done' }) }))
  for (const id of ['a', 'b', 'c']) work(id)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(order, ['a', 'b'])
  await wait(['a', 'b', 'c'], 'all', 0.05, new AbortController().signal)
  assert.deepEqual(['a', 'b', 'c'].map(isRunning), [true, true, true], 'a wait that times out leaves the work running')
  gates.a()
  await wait(['a', 'b', 'c'], 'any', 5, new AbortController().signal)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(order, ['a', 'b', 'c'])
  gates.b(); gates.c()
  await wait(['b', 'c'], 'all', 5, new AbortController().signal)
  assert.deepEqual(['a', 'b', 'c'].map(id => resultOf(id)?.status), ['done', 'done', 'done'])
  start('failing', 'lane', 2, async () => { throw new Error('broke') })
  await wait(['failing'], 'all', 5, new AbortController().signal)
  assert.deepEqual(resultOf('failing'), { status: 'error', error: 'broke' })
})

test('spaced work takes its turns a gap apart, and only while the gap lasts', async () => {
  const began = Date.now()
  const at = await Promise.all(['a', 'b', 'c'].map(() => spaced('test', 0.05).then(() => Date.now() - began)))
  assert.ok(at[0] < 40 && at[1] >= 45 && at[2] >= 95, String(at))
  await new Promise(resolve => setTimeout(resolve, 80))
  const later = Date.now()
  await spaced('test', 0.05)
  assert.ok(Date.now() - later < 40, 'a turn long after the last one comes at once')
})

test('a transcript is written in brief, bounded and complete, with its images', async t => {
  const root = await directory(t)
  const message = message => JSON.stringify({ type: 'message', message })
  await writeFile(path.join(root, 'session.jsonl'), [
    JSON.stringify({ type: 'session', version: 2, id: 'x' }),
    message({ role: 'user', content: 'press the button' }),
    JSON.stringify({ type: 'custom_message', customType: 'kinex-context', content: 'hidden context' }),
    message({ role: 'assistant', usage: { input: 10, cacheRead: 90, output: 7 }, content: [{ type: 'thinking', thinking: 'hm' }, { type: 'text', text: 'Looking.' },
      { type: 'toolCall', id: 'c1', name: 'device', arguments: { deviceID: 'camera', note: 'n'.repeat(2000) } }, { type: 'toolCall', id: 'c2', name: 'skill', arguments: { name: 'press' } }] }),
    message({ role: 'toolResult', toolCallId: 'c1', toolName: 'device', isError: true, content: [{ type: 'text', text: 'o'.repeat(3000) }, { type: 'image', mimeType: 'image/png', data: Buffer.from('PNG').toString('base64') }] }),
    message({ role: 'toolResult', toolCallId: 'c2', toolName: 'skill', content: [{ type: 'text', text: 'how to press' }] }),
    message({ role: 'assistant', usage: { input: 5, output: 3 }, content: [{ type: 'text', text: 'Done.' }] }),
  ].join('\n') + '\n')
  await writeTranscript(root, { id: 't001', task: 'sim/press', library: 'L1', status: 'done', success: true, steps: 12, reason: 'success', wallS: 30, note: 'worker exited 1; see output.log' })
  const history = await readFile(path.join(root, 'history.md'), 'utf8')
  assert.match(history, /^## user\n\npress the button\n\n## assistant\n\nLooking\.\n\n### call 1: device \(error\)\n\n```json\n/)
  assert.match(history, /…\(\d+ more characters; the full text is in history\.json\)\n```\n\n```\no+\n…\(1000 more characters; the full text is in history\.json\)\n```\n\n!\[call 1\]\(images\/001\.png\)\n\n### call 2: skill\n/)
  assert.match(history, /```\nhow to press\n```\n\n## assistant\n\nDone\.\n$/)
  assert.doesNotMatch(history, /hidden context|hm/)
  assert.equal(await readFile(path.join(root, 'images/001.png'), 'utf8'), 'PNG')
  assert.ok(history.length < 4700)
  const full = JSON.parse(await readFile(path.join(root, 'history.json'), 'utf8'))
  assert.deepEqual(full.map(entry => entry.call ?? entry.role), ['user', 'assistant', 1, 2, 'assistant'])
  assert.deepEqual(full[2], { call: 1, name: 'device', input: { deviceID: 'camera', note: 'n'.repeat(2000) }, output: 'o'.repeat(3000), error: true, images: ['images/001.png'] })
  const summary = await readFile(path.join(root, 'summary.md'), 'utf8')
  assert.match(summary, /^# t001 — sim\/press\n\nVerdict: success, 12 steps\. Cost: 2 tool calls, 30 s, 105 input \/ 10 output tokens\.\nLibrary: L1\. Skills loaded: \[press\]\.\nHost note: worker exited 1; see output\.log\n/)
  assert.match(summary, /## Tools called \(2\)\ndevice ×1, skill ×1\n\n## Errors \(1\)\n1\. device\(.*…\) → error: o+…\n\n## Last 12 calls\n1\. .*\n2\. skill\(\{"name":"press"\}\): how to press\n\n## Last words\nDone\.\n/)
})

test('what a worker kept is copied apart from the library it was shipped, and reaches the distiller', async t => {
  const root = await directory(t)
  await createLibrary(root)
  const candidate = path.join(root, 'candidate')
  await put(path.join(candidate, 'payload/skills/press/SKILL.md'), skill('press'))
  await put(path.join(candidate, 'payload/skills/kept/SKILL.md'), skill('kept'))
  await put(path.join(candidate, 'payload/skills/gone/SKILL.md'), skill('gone'))
  await put(path.join(candidate, 'payload/skills/rig-code/SKILL.md'), `${skill('rig-code')}def move():\n    return 1\n`)
  await publish(root, candidate, { parent: 'L0', source: 'd001' })
  const input = { task: 'sim/press', robot: 'arm', library: 'L1', timeoutS: 60 }
  const job = await openJob(trialsDir(root), 't', input)
  await install(path.join(root, 'libraries/L1'), job.workspace)
  const kinex = path.join(job.workspace, '.kinex')
  await put(path.join(kinex, 'lib/rig.py'), 'def move():\n    return 1\n')
  await put(path.join(kinex, 'lib/grasp.py'), '# Grasp helpers.\ndef pick(): ...\n')
  await put(path.join(kinex, 'lib/__pycache__/grasp.cpython-312.pyc'), 'cache')
  await put(path.join(kinex, 'skills/press/SKILL.md'), skill('press', 'press harder'))
  await put(path.join(kinex, 'skills/doors/SKILL.md'), skill('doors', 'open a door'))
  await put(path.join(kinex, 'memos/sim.md'), '# Notes on the rig\n')
  await put(path.join(kinex, 'devices/arm/profile.yaml'), 'not kept')
  await put(path.join(job.workspace, 'scratch.py'), 'not kept')
  await rm(path.join(kinex, 'skills/gone'), { recursive: true })
  await put(path.join(job.record, 'session.jsonl'), '')
  const result = await finishJob(job, { status: 'done', success: true, steps: 3 })
  await writeRecord(root, { id: job.id, ...input, ...result })
  const files = (await readdir(path.join(job.record, 'learned'), { recursive: true, withFileTypes: true })).filter(entry => entry.isFile())
    .map(entry => path.relative(job.record, path.join(entry.parentPath, entry.name))).sort()
  assert.deepEqual(files, ['learned/.kinex/lib/grasp.py', 'learned/.kinex/memos/sim.md', 'learned/.kinex/skills/doors/SKILL.md', 'learned/.kinex/skills/press/SKILL.md'])
  const learned = await readFile(path.join(job.record, 'learned.md'), 'utf8')
  assert.match(learned, /## Code\n- \.kinex\/lib\/grasp\.py: new \(not in the library\), 33 B — learned\/\.kinex\/lib\/grasp\.py\n  begins: Grasp helpers\.\n/)
  assert.match(learned, /## Skills\n- \.kinex\/skills\/doors: new \(not in the library\), \d+ B — learned\/\.kinex\/skills\/doors\/\n  open a door\n- \.kinex\/skills\/press: changed from the library as shipped, \d+ B — learned\/\.kinex\/skills\/press\/\n  press harder\n/)
  assert.match(learned, /## Notes\n- \.kinex\/memos\/sim\.md: new \(not in the library\), 19 B — learned\/\.kinex\/memos\/sim\.md\n  begins: Notes on the rig\n/)
  assert.match(learned, /## The library as shipped\n- unchanged: \.kinex\/lib\/rig\.py \(extracted unchanged from the skill rig-code\), \.kinex\/skills\/kept, \.kinex\/skills\/rig-code\n- library files the sub-agent removed: \.kinex\/skills\/gone\/SKILL\.md\n$/)

  const records = path.join(root, 'records')
  await collect(root, { selection: 'x', rounds: 1, parallel: 1, trialTimeoutS: 60, distillTimeoutS: 60, rosbridge: 'rosbridge' }, { base: 'L1', trials: [job.id], fresh: [job.id], timeoutS: 60 }, records)
  assert.deepEqual((await readdir(path.join(records, job.id))).sort(), ['history.json', 'history.md', 'learned', 'learned.md', 'result.json', 'summary.md'])
  assert.equal(await readFile(path.join(records, job.id, 'learned/.kinex/lib/grasp.py'), 'utf8'), '# Grasp helpers.\ndef pick(): ...\n')
})

test('the reference holds the Python package, the built-in tools and the robot workspace, without caches', async t => {
  const root = await directory(t)
  const rig = path.join(root, 'trial/.kinex')
  await put(path.join(rig, 'workspace.yaml'), 'identity: {}\n')
  await put(path.join(rig, 'devices/arm/profile.yaml'), 'operations: {}\n')
  await put(path.join(rig, 'devices/arm/__pycache__/links.pyc'), 'cache')
  await put(path.join(rig, 'lib/own.py'), 'a worker file, not reference')
  const directory_ = path.join(root, 'reference')
  await reference(directory_, rig)
  assert.deepEqual((await readdir(directory_)).sort(), ['INDEX.md', 'builtin-tool', 'kinex-core.md', 'python-kinex', 'workspace'])
  assert.match(await readFile(path.join(directory_, 'python-kinex/helpers/helpers.txt'), 'utf8'), /from kinex import helpers/)
  assert.match(await readFile(path.join(directory_, 'python-kinex/__init__.py'), 'utf8'), /communication/)
  for (const tool of await readdir(path.join(directory_, 'builtin-tool'))) assert.ok((await readdir(path.join(directory_, 'builtin-tool', tool))).includes('tool.yaml'), tool)
  assert.deepEqual((await readdir(path.join(directory_, 'workspace'))).sort(), ['devices', 'workspace.yaml'])
  assert.deepEqual(await readdir(path.join(directory_, 'workspace/devices/arm')), ['profile.yaml'])
  assert.ok(!(await readdir(directory_, { recursive: true })).some(entry => entry.includes('__pycache__')))
  for (const part of ['python-kinex/', 'builtin-tool/', 'workspace/']) assert.match(await readFile(path.join(directory_, 'INDEX.md'), 'utf8'), new RegExp(`^- ${part}:`, 'm'))
  await reference(path.join(root, 'bare'), undefined)
  assert.ok(!(await readdir(path.join(root, 'bare'))).includes('workspace'))
})

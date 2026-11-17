import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { check, createLibrary, install, installedBrief, newestVersion, publish, versions } from '../dist/library.js'
import { renderHistory, renderStatus, scan } from '../dist/records.js'
import { openJob, finishJob, start, wait, isRunning, resultOf } from '../dist/job.js'
import { trialsDir, distillationsDir } from '../dist/layout.js'
import { judged } from '../dist/trial.js'

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

test('a transcript renders turns, calls, results and images', async t => {
  const root = await directory(t)
  const message = message => JSON.stringify({ type: 'message', message })
  await writeFile(path.join(root, 'session.jsonl'), [
    JSON.stringify({ type: 'session', version: 2, id: 'x' }),
    message({ role: 'user', content: 'press the button' }),
    JSON.stringify({ type: 'custom_message', customType: 'kinex-context', content: 'hidden context' }),
    message({ role: 'assistant', content: [{ type: 'thinking', thinking: 'hm' }, { type: 'text', text: 'Looking.' }, { type: 'toolCall', id: 'c1', name: 'device', arguments: { deviceID: 'camera', note: 'n'.repeat(2000) } }] }),
    message({ role: 'toolResult', toolCallId: 'c1', toolName: 'device', isError: true, content: [{ type: 'text', text: 'o'.repeat(3000) }, { type: 'image', mimeType: 'image/png', data: Buffer.from('PNG').toString('base64') }] }),
    message({ role: 'assistant', content: [{ type: 'text', text: 'Done.' }] }),
  ].join('\n') + '\n')
  await renderHistory(path.join(root, 'session.jsonl'), root)
  const history = await readFile(path.join(root, 'history.md'), 'utf8')
  assert.match(history, /^## user\n\npress the button\n\n## assistant\n\nLooking\.\n\n### call 1: device\n/)
  assert.match(history, /…\(\d+ more characters\)\n```\n\nresult of call 1 \(error\):/)
  assert.match(history, /!\[call 1\]\(images\/001\.png\)\n\n## assistant\n\nDone\.\n$/)
  assert.doesNotMatch(history, /hidden context|hm/)
  assert.equal(await readFile(path.join(root, 'images/001.png'), 'utf8'), 'PNG')
  assert.ok(history.length < 4500)
})

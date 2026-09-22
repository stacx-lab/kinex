import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import path from 'node:path'
import { isolate, fakeProvider, workspace, bind, seed } from './helpers.mjs'

const isolation = await isolate()
after(isolation.cleanup)
const { createApplication } = await import('../dist/application.js')
const summaryRule = 'Robotics continuity requirements for this summary:'
const isSummary = request => JSON.stringify(request.messages).includes(summaryRule)
const messageText = message => typeof message.content === 'string' ? message.content : (message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')
const contexts = app => app.host.session.sessionManager.getBranch().filter(entry => entry.type === 'custom_message' && entry.customType === 'kinex-context')
const marker = { name: 'write', args: { path: 'should-not-exist', content: 'started' } }

async function fixture(t, mode = 'auto') {
  const cwd = await workspace(t)
  const fake = await fakeProvider(t, isolation.root)
  const app = await createApplication({ cwd, model: 'fake/test', mode })
  t.after(() => app.dispose())
  await seed(app.owner.runtime)
  return { cwd, fake, app }
}

async function custom(cwd, name, body) {
  await mkdir(path.join(cwd, '.kinex/tool'), { recursive: true })
  await writeFile(path.join(cwd, '.kinex/tool', `${name}.ts`), body)
}

for (const denied of [
  { name: 'device', args: { deviceID: 'sensor', action: 'load' } },
  { name: 'calib_write', args: { kind: 'robot', data: { identity: { name: 'must not change' } } } },
  { name: 'denied_controller', args: {} },
]) {
  test(`${denied.name} denial stops mixed-batch siblings and the session can continue`, async t => {
    const { cwd, fake, app } = await fixture(t, 'ask')
    await writeFile(path.join(cwd, '.kinex/kinex.json'), JSON.stringify({ permission: { write: 'allow', calib_write: 'deny' } }))
    await custom(cwd, 'sibling', `import {writeFile} from 'node:fs/promises';import path from 'node:path';export default {
      description:'Sibling marker',execute:async(_,ctx)=>{await writeFile(path.join(ctx.directory,'core-started'),'started');return {title:'marker',output:'started'}}
    }`)
    const directory = path.join(cwd, '.kinex/tool/denied_controller')
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, 'tool.yaml'), 'name: denied_controller\nkind: controller\ndescription: Permission test\ninterpreter: python3\n')
    await writeFile(path.join(directory, 'tool.py'), 'raise RuntimeError("must not run")\n')
    await bind(app)
    fake.steps.push({ tools: [{ name: 'write', args: { path: 'completed.txt', content: 'completed' } }, denied, { name: 'sibling' }, marker] })
    await app.host.session.prompt('exercise a denied batch')
    assert.equal(fake.requests.length, 1)
    assert.equal(await readFile(path.join(cwd, 'completed.txt'), 'utf8'), 'completed', 'completed work is not rolled back')
    for (const file of ['core-started', 'should-not-exist']) await assert.rejects(stat(path.join(cwd, file)), { code: 'ENOENT' })
    assert.equal((await app.owner.runtime.devices.list())[0].loaded, false)
    const results = app.host.session.agent.state.messages.filter(message => message.role === 'toolResult')
    assert.equal(results.length, 2)
    assert.match(JSON.stringify(results[1].content), /[Pp]ermission/)
    fake.steps.push({ text: 'RECOVERED' })
    if (denied.name === 'device') {
      const session = app.host.session.sessionFile
      await app.dispose()
      const resumed = await createApplication({ cwd, session, model: 'fake/test', mode: 'ask' })
      t.after(() => resumed.dispose())
      await bind(resumed)
      await resumed.host.session.prompt('resume after a denied batch')
    } else await app.host.session.prompt('continue with a different task')
    assert.equal(fake.requests.length, 2)
    assert.ok(fake.requests[1].messages.some(message => message.role === 'user'))
  })
}

test('a newly discovered core tool makes the entire mixed batch sequential', async t => {
  const { cwd, fake, app } = await fixture(t)
  await bind(app)
  fake.steps.push({ text: 'baseline' })
  await app.host.session.prompt('baseline')
  await custom(cwd, 'check', `import {readFile} from 'node:fs/promises';import path from 'node:path';export default {
    description:'Observe preceding write',execute:async(_,ctx)=>({title:'check',output:'OBSERVED:'+await readFile(path.join(ctx.directory,'before.txt'),'utf8')})
  }`)
  fake.steps.push({ tools: [
    { name: 'bash', args: { command: 'sleep 0.15; echo READY > before.txt' } },
    { name: 'check' },
    { name: 'device', args: { deviceID: 'sensor', action: 'load' } },
    { name: 'device', args: { deviceID: 'sensor', action: 'read' } },
  ] }, { text: 'done' })
  await app.host.session.prompt('run ordered work')
  assert.match(JSON.stringify(fake.requests[2].messages), /OBSERVED:READY/)
  const results = app.host.session.agent.state.messages.filter(message => message.role === 'toolResult')
  assert.equal(results.length, 4)
  assert.ok(results.every(result => !result.isError))
  assert.equal((await app.owner.runtime.devices.list())[0].loaded, true)
})

test('pure coding batches retain parallel execution', { timeout: 15000 }, async t => {
  const { cwd, fake, app } = await fixture(t)
  await bind(app)
  const rendezvous = (self, other) => `touch ${self}; for i in $(seq 1 100); do if test -f ${other}; then echo BARRIER_OK; exit 0; fi; sleep 0.02; done; exit 1`
  fake.steps.push({ tools: [
    { name: 'bash', args: { command: rendezvous('a', 'b') } },
    { name: 'bash', args: { command: rendezvous('b', 'a') } },
  ] }, { text: 'done' })
  await app.host.session.prompt('parallel rendezvous')
  const results = app.host.session.agent.state.messages.filter(message => message.role === 'toolResult')
  assert.equal(results.length, 2)
  assert.ok(results.every(result => !result.isError && JSON.stringify(result.content).includes('BARRIER_OK')))
})

test('cancelling an active mixed batch prevents subsequent core and coding calls', { timeout: 15000 }, async t => {
  const { cwd, fake, app } = await fixture(t)
  await custom(cwd, 'waiting', `import {writeFile} from 'node:fs/promises';import path from 'node:path';import {setTimeout} from 'node:timers/promises';export default {
    description:'Cancellable wait',execute:async(_,ctx)=>{await writeFile(path.join(ctx.directory,'waiting'),'started');await setTimeout(30000,undefined,{signal:ctx.abort});return {title:'wait',output:'done'}}
  }`)
  await bind(app)
  fake.steps.push({ tools: [{ name: 'waiting' }, { name: 'device', args: { deviceID: 'sensor', action: 'load' } }, marker] })
  const running = app.host.session.prompt('wait and then act')
  for (let i = 0; i < 100 && !await stat(path.join(cwd, 'waiting')).then(() => true, () => false); i++) await delay(20)
  await stat(path.join(cwd, 'waiting'))
  await app.host.session.abort()
  await running
  await assert.rejects(stat(path.join(cwd, 'should-not-exist')), { code: 'ENOENT' })
  assert.equal((await app.owner.runtime.devices.list())[0].loaded, false)
  fake.steps.push({ text: 'RECOVERED' })
  await app.host.session.prompt('continue')
  assert.equal(fake.requests.length, 2)
})

test('question cancellation prevents later calls even in auto mode', async t => {
  const { cwd, fake, app } = await fixture(t)
  await bind(app, {
    setHeader() {}, setStatus() {}, setWidget() {}, addAutocompleteProvider() {}, notify() {},
    select: async () => undefined,
  })
  fake.steps.push({ tools: [
    { name: 'question', args: { questions: [{ header: 'Choice', question: 'Continue?', options: [{ label: 'Yes' }] }] } },
    marker, { name: 'device', args: { deviceID: 'sensor', action: 'load' } },
  ] })
  await app.host.session.prompt('ask before acting')
  assert.equal(fake.requests.length, 1)
  await assert.rejects(stat(path.join(cwd, 'should-not-exist')), { code: 'ENOENT' })
  assert.equal((await app.owner.runtime.devices.list())[0].loaded, false)
})

function assertSnapshot(app) {
  const branch = app.host.session.sessionManager.getBranch()
  const index = branch.findLastIndex(entry => entry.type === 'compaction')
  assert.ok(index >= 0)
  const snapshots = branch.slice(index + 1).filter(entry => entry.type === 'custom_message' && entry.customType === 'kinex-context')
  assert.equal(snapshots.length, 1)
  const snapshot = snapshots[0]
  for (const section of ['python', 'guides', 'devices', 'conventions', 'skills', 'recording', 'problems']) assert.ok(snapshot.content.includes(`${section}:\n`), section)
  assert.ok(app.host.session.agent.state.messages.some(message => message.role === 'custom' && message.content === snapshot.content))
  return snapshot
}

test('manual compaction keeps user focus, adds robotics rules and immediately persists a full snapshot', async t => {
  const { fake, app, cwd } = await fixture(t)
  await bind(app)
  fake.steps.push({ text: 'Motion command accepted; completion has not been observed.' }, { text: 'Need to verify completion.' })
  await app.host.session.prompt('Move sensor after calibration value 0.125 m in world frame')
  await app.host.session.prompt('Retain the unverified action')
  await app.host.session.prompt('/load sensor')
  app.host.services.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1, reserveTokens: 512 } })
  fake.respond = request => ({ text: isSummary(request) ? 'SUMMARY: sensor command accepted, motion unverified; calibration 0.125 m in world.' : 'AFTER_COMPACTION' })
  await app.host.session.compact('USER_FOCUS: retain pending calibration checks')
  const snapshot = assertSnapshot(app)
  const summaryRequests = fake.requests.filter(isSummary)
  assert.ok(summaryRequests.length >= 1)
  assert.ok(summaryRequests.some(request => JSON.stringify(request).includes('USER_FOCUS')))
  assert.ok(summaryRequests.some(request => JSON.stringify(request).includes('0.125 m')))
  assert.ok(summaryRequests.every(request => JSON.stringify(request).includes('Never turn command acceptance into a claim of motion completion')))
  const session = app.host.session.sessionFile
  const persisted = await readFile(session, 'utf8')
  assert.ok(persisted.includes('SUMMARY: sensor'))
  const snapshotCount = contexts(app).length
  await app.host.session.prompt('continue')
  assert.equal(contexts(app).length, snapshotCount)
  assert.ok(fake.requests.at(-1).messages.some(message => messageText(message).includes(snapshot.content)))
  assert.equal(isSummary(fake.requests.at(-1)), false)
  await app.dispose()
  const resumed = await createApplication({ cwd, session, model: 'fake/test', mode: 'auto' })
  t.after(() => resumed.dispose())
  await bind(resumed)
  await resumed.host.session.prompt('resume')
  assert.equal(isSummary(fake.requests.at(-1)), false)
  assert.equal(contexts(resumed).length, snapshotCount)
})

for (const reason of ['threshold', 'overflow']) {
  test(`${reason} compaction restores current state before the first automatic continuation`, async t => {
    const { fake, app } = await fixture(t)
    await bind(app)
    app.host.services.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1, reserveTokens: 16384 } })
    let mainCalls = 0
    let summaries = 0
    fake.respond = async request => {
      if (isSummary(request)) {
        summaries++
        await (await app.owner.runtime.devices.load('sensor')).ready
        return { text: 'SUMMARY: the task is unfinished; verify the current device state.' }
      }
      mainCalls++
      if (mainCalls === 1) return { tools: [{ name: 'device', args: { deviceID: 'sensor', action: 'status' } }], inputTokens: reason === 'threshold' ? 120000 : 1000 }
      if (reason === 'overflow' && mainCalls === 2) return { status: 400, body: JSON.stringify({ error: { message: 'maximum context length exceeded', type: 'invalid_request_error' } }) }
      return { text: 'CONTINUED_WITH_CURRENT_STATE' }
    }
    await app.host.session.prompt('a task that compacts without another user prompt')
    assert.ok(summaries >= 1)
    assert.equal(mainCalls, reason === 'threshold' ? 2 : 3)
    const snapshot = assertSnapshot(app)
    assert.ok(fake.requests.at(-1).messages.some(message => messageText(message).includes(snapshot.content)))
    assert.equal((await app.owner.runtime.devices.list())[0].loaded, true)
    assert.equal(isSummary(fake.requests.at(-1)), false)
  })
}

test('Pi retries summary requests with robotics rules and commits one snapshot', async t => {
  const { app, fake } = await fixture(t)
  await bind(app)
  await app.host.session.prompt('baseline')
  await app.host.session.prompt('another turn')
  app.host.services.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1, reserveTokens: 512 } })
  let attempts = 0
  fake.respond = request => {
    if (!isSummary(request)) return { text: 'NORMAL_REPLY' }
    if (++attempts === 1) return { status: 500 }
    return { text: 'RETRIED_SUMMARY' }
  }
  await app.host.session.compact()
  assert.equal(attempts, 3, 'split-turn compaction makes two summaries and retries the failed request once')
  const summaryRequests = fake.requests.filter(isSummary)
  const payloads = summaryRequests.map(request => JSON.stringify(request.messages))
  assert.equal(new Set(payloads).size, 2, 'the retry preserves its original summary request')
  assertSnapshot(app)
  await app.host.session.prompt('continue')
  assert.equal(isSummary(fake.requests.at(-1)), false)
})

for (const failure of ['failure', 'cancel']) {
  test(`summary ${failure} preserves history and does not leak rules into the next run`, { timeout: 15000 }, async t => {
    const { app, fake } = await fixture(t)
    await bind(app)
    await app.host.session.prompt('baseline')
    await app.host.session.prompt('another turn')
    app.host.services.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1, reserveTokens: 512 } })
    const before = app.host.session.sessionManager.getBranch()
    let release
    let started
    const waiting = new Promise(resolve => { release = resolve })
    const requested = new Promise(resolve => { started = resolve })
    t.after(release)
    fake.respond = request => {
      if (!isSummary(request)) return { text: 'NORMAL_REPLY' }
      started()
      return failure === 'failure' ? { status: 400, body: 'SUMMARY_REJECTED' } : { wait: waiting, text: 'must not commit' }
    }
    const compacting = app.host.session.compact()
    const rejected = assert.rejects(compacting)
    await requested
    if (failure === 'cancel') app.host.session.abortCompaction()
    await rejected
    release()
    assert.deepEqual(app.host.session.sessionManager.getBranch(), before)
    await app.host.session.prompt('continue after failed summary')
    assert.equal(isSummary(fake.requests.at(-1)), false)
    fake.respond = () => ({ text: 'RECOVERED_SUMMARY' })
    await app.host.session.compact()
    assertSnapshot(app)
    assert.ok(isSummary(fake.requests.at(-1)))
  })
}

test('post-compaction snapshot failure aborts continuation and can recover on a later prompt', async t => {
  const { app, fake } = await fixture(t)
  const errors = []
  await app.host.session.bindExtensions({ mode: 'print', onError: error => errors.push(error.error) })
  app.host.services.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1, reserveTokens: 16384 } })
  const context = app.owner.runtime.context
  let failContext = false
  app.owner.runtime.context = () => failContext ? Promise.reject(new Error('SNAPSHOT_UNAVAILABLE')) : context()
  let mainCalls = 0
  fake.respond = request => {
    if (isSummary(request)) {
      failContext = true
      return { text: 'SUMMARY' }
    }
    mainCalls++
    return mainCalls === 1 ? { tool: 'device', args: { deviceID: 'sensor', action: 'status' }, inputTokens: 120000 } : { text: 'RECOVERED' }
  }
  await app.host.session.prompt('trigger compaction')
  assert.equal(mainCalls, 1, 'no model continuation may run with a missing snapshot')
  assert.ok(errors.some(error => error.includes('SNAPSHOT_UNAVAILABLE')))
  assert.match(app.owner.failure.message, /SNAPSHOT_UNAVAILABLE/)
  await app.host.session.prompt('retry while state is still unavailable')
  assert.equal(mainCalls, 1, 'a failed retry must not silently use the stale summary')
  failContext = false
  await app.host.session.prompt('recover')
  assert.equal(mainCalls, 2)
  assert.equal(app.owner.failure, undefined)
  assertSnapshot(app)
})

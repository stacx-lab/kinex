import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { isolate, fakeProvider, workspace, bind } from './helpers.mjs'

const isolation = await isolate()
after(isolation.cleanup)
const { createKinexRuntime } = await import('@kinex/core')
const { createScope, inScope } = await import('@kinex/core/scope')
const { createApplication } = await import('../dist/application.js')
const { selfImproveContribution } = await import('@kinex/self-improve')
const { start, isRunning, runningIDs } = await import('@kinex/self-improve/job')

const scheduler = ['improve_tasks', 'improve_run_trial', 'improve_distill', 'improve_wait', 'improve_status']
const names = async contribution => (await contribution.tools.list()).tools.map(tool => tool.name)
const rules = async contribution => (await contribution.context()).sections.run
const command = { sessionID: 'session', confirm: async () => false }
const invocation = directory => ({ sessionID: 'session', callID: 'call', directory, abort: new AbortController().signal, ask: async () => {}, questions: async () => ({}) })

test('only the session that ran /self-improve is the scheduler, until it stops', async t => {
  const directory = await workspace(t)
  const runtime = createKinexRuntime({ directory })
  t.after(() => runtime.dispose())
  // A host makes one contribution per session of a runtime.
  const first = selfImproveContribution(runtime)
  const second = selfImproveContribution(runtime)
  const started = await first.commands[0].execute('sim/open-door --rounds 2', command)
  assert.equal(started.kind, 'workflow')
  assert.deepEqual(await names(first), scheduler)
  assert.match(await rules(first), /you are its scheduler/)
  assert.match((await first.tools.call('improve_status', {}, invocation(directory))).output, /Library versions: L0/)

  assert.deepEqual(await names(second), [], 'another session of the same runtime has no scheduler tools')
  assert.equal(await rules(second), undefined)
  assert.throws(() => second.tools.call('improve_status', {}, invocation(directory)), /unknown self-improve tool/)
  assert.deepEqual(await second.commands[0].execute('stop', command), { kind: 'output', text: 'This session schedules no self-improve run.' })

  const stopped = await first.commands[0].execute('stop', command)
  assert.match(stopped.text, /^Stopped scheduling .*self-improve/)
  assert.deepEqual(await names(first), [])
  assert.match(await rules(first), /no longer scheduled in this session/)
  await assert.rejects(first.commands[0].execute('stop now', command), /Usage: \/self-improve/)

  const resumed = await second.commands[0].execute('resume', command)
  assert.match(resumed.prompt, /^Continue the self-improve run /)
  assert.deepEqual(await names(second), scheduler)
  assert.match(await rules(second), /Request: sim\/open-door\nRounds: 2\./)
})

test('a new session of the application is not the scheduler of the session before it', { timeout: 60000 }, async t => {
  const fake = await fakeProvider(t, isolation.root)
  fake.respond = () => ({ text: 'NOTED' })
  const app = await createApplication({ cwd: await workspace(t), model: 'fake/test', mode: 'yolo' })
  t.after(() => app.dispose())
  await bind(app)
  const improve = request => request.tools.map(tool => tool.function.name).filter(name => name.startsWith('improve_')).sort()
  await app.host.session.prompt('/self-improve sim/open-door')
  // The command's prompt is delivered as a follow-up, so its turn starts after the command returns.
  for (let attempt = 0; attempt < 200 && !fake.requests.length; attempt++) await new Promise(resolve => setTimeout(resolve, 50))
  await app.host.session.waitForIdle()
  assert.deepEqual(improve(fake.requests.at(-1)), [...scheduler].sort())
  assert.match(JSON.stringify(fake.requests.at(-1).messages), /you are its scheduler/)

  app.host.setRebindSession(() => bind(app))
  await app.host.newSession()
  await app.host.session.prompt('hello')
  assert.deepEqual(improve(fake.requests.at(-1)), [])
  assert.doesNotMatch(JSON.stringify(fake.requests.at(-1).messages), /you are its scheduler/)
})

test('jobs are kept by the runtime that started them', async () => {
  const one = createScope(), two = createScope()
  const gate = Promise.withResolvers()
  inScope(one, () => start('t001', 'trials', 1, () => gate.promise))
  assert.equal(inScope(one, () => isRunning('t001')), true)
  assert.deepEqual(inScope(two, runningIDs), [])
  assert.deepEqual(runningIDs(), [])
  gate.resolve({ status: 'done' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(inScope(one, () => isRunning('t001')), false)
})

test('loading self-improve registers no process listener', async () => {
  const entry = fileURLToPath(import.meta.resolve('@kinex/self-improve'))
  const script = `const before = process.listenerCount('exit'); await import(${JSON.stringify(entry)}); console.log(process.listenerCount('exit') - before)`
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script])
  assert.equal(stdout.trim(), '0')
})

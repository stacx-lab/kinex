import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isolate, fakeProvider, workspace, bind } from './helpers.mjs'

const isolation = await isolate()
after(isolation.cleanup)
const { createApplication } = await import('../dist/application.js')

async function application(t, provider = 'openai') {
  const cwd = await workspace(t)
  const fake = await fakeProvider(t, isolation.root)
  const file = path.join(isolation.root, 'config', 'agent', 'models.json')
  const models = JSON.parse(await readFile(file, 'utf8'))
  models.providers.openai = models.providers.fake
  await writeFile(file, JSON.stringify(models))
  const messages = []
  const app = await createApplication({ cwd, model: `${provider}/test`, mode: 'auto', report: text => messages.push(text) })
  t.after(() => app.dispose())
  await bind(app)
  return { app, fake, messages }
}

test('OpenAI Fast mode changes outgoing requests only after selection and resets on reload', async t => {
  const { app, fake, messages } = await application(t)
  const session = app.host.session
  await session.prompt('Default request')
  assert.equal(fake.requests.at(-1).service_tier, undefined)
  await session.prompt('/openai-fast')
  assert.match(messages.at(-1), /provider\/project default/)
  await session.prompt('/openai-fast on')
  assert.match(messages.at(-1), /premium API pricing/)
  await session.prompt('Priority request')
  assert.equal(fake.requests.at(-1).service_tier, 'priority')
  await session.prompt('/openai-fast status')
  await session.prompt('/openai-fast invalid')
  assert.match(messages.at(-1), /Usage:/)
  await session.prompt('Still priority')
  assert.equal(fake.requests.at(-1).service_tier, 'priority')
  await session.prompt('/openai-fast off')
  await session.prompt('Standard request')
  assert.equal(fake.requests.at(-1).service_tier, 'default')
  await session.prompt('/openai-fast on')
  await session.reload()
  await session.prompt('Reloaded request')
  assert.equal(fake.requests.at(-1).service_tier, undefined)
  assert.equal(fake.requests.length, 5, 'commands do not send model requests')
})

test('Fast mode leaves compatible non-OpenAI providers untouched', async t => {
  const { app, fake, messages } = await application(t, 'fake')
  await app.host.session.prompt('/openai-fast on')
  assert.match(messages.at(-1), /Inactive for this provider/)
  await app.host.session.prompt('Compatible provider')
  assert.equal(fake.requests.at(-1).service_tier, undefined)
})

test('Fast mode selection is not restored by new or resumed sessions', async t => {
  const { app, fake } = await application(t)
  await app.host.session.prompt('/openai-fast on')
  await app.host.session.prompt('Priority in the original session')
  const original = app.host.session.sessionManager.getSessionFile()
  assert.ok(original)
  app.host.setRebindSession(() => bind(app))
  await app.host.newSession()
  await app.host.session.prompt('Default in the new session')
  assert.equal(fake.requests.at(-1).service_tier, undefined)
  await app.host.session.prompt('/openai-fast on')
  await app.host.switchSession(original)
  await app.host.session.prompt('Default in the resumed session')
  assert.equal(fake.requests.at(-1).service_tier, undefined)
})

test('OpenAI Fast mode completes command arguments', async t => {
  const { app } = await application(t)
  const command = app.host.session.extensionRunner.getCommand('openai-fast')
  const complete = async prefix => (await command.getArgumentCompletions(prefix))?.map(item => item.value) ?? null
  assert.deepEqual(await complete(''), ['on', 'off', 'status'])
  assert.deepEqual(await complete('o'), ['on', 'off'])
  assert.deepEqual(await complete('st'), ['status'])
  assert.deepEqual(await complete('ON'), ['on'])
  assert.equal(await complete('invalid'), null)
})

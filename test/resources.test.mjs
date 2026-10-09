import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile, stat, readdir } from 'node:fs/promises'
import path from 'node:path'
import { isolate, fakeProvider, workspace, bind, seed } from './helpers.mjs'

const isolation = await isolate()
after(isolation.cleanup)
const { createApplication } = await import('../dist/application.js')

async function packageFixture(cwd, extension) {
  const dir = path.join(cwd, 'resources')
  await mkdir(path.join(dir, 'skills', 'package-probe'), { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'resource-fixture', type: 'module', pi: {
    extensions: ['./index.ts'], skills: ['./skills'], prompts: ['./probe-prompt.md'], themes: ['./probe-theme.json'],
  } }))
  await writeFile(path.join(dir, 'index.ts'), extension)
  await writeFile(path.join(dir, 'skills/package-probe/SKILL.md'), '---\nname: package-probe\ndescription: Inspect package resource integration\n---\nPACKAGE_SKILL_BODY\n')
  await writeFile(path.join(dir, 'probe-prompt.md'), '---\ndescription: Package prompt\n---\nPACKAGE_PROMPT $1\n')
  const theme = JSON.parse(await readFile(new URL('../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json', import.meta.url), 'utf8'))
  theme.name = 'probe-theme'
  await writeFile(path.join(dir, 'probe-theme.json'), JSON.stringify(theme))
  await mkdir(path.join(cwd, '.kinex/agent'), { recursive: true })
  await writeFile(path.join(cwd, '.kinex/agent/settings.json'), JSON.stringify({ packages: [dir], theme: 'probe-theme' }))
  return dir
}

test('Pi package skills, prompts, themes and extensions coexist with Kinex across reload', async t => {
  const cwd = await workspace(t)
  const fake = await fakeProvider(t, isolation.root)
  const dir = await packageFixture(cwd, `export default pi => pi.registerCommand('package-command', {
    handler: async () => pi.appendEntry('package-command-ran', {})
  })`)
  await mkdir(path.join(cwd, '.pi'), { recursive: true })
  await writeFile(path.join(cwd, '.pi/settings.json'), 'invalid Pi settings must not be read')
  const app = await createApplication({ cwd, model: 'fake/test', mode: 'auto' })
  t.after(() => app.dispose())
  await bind(app)
  const loader = app.host.services.resourceLoader
  assert.ok(loader.getSkills().skills.some(skill => skill.name === 'package-probe'))
  assert.ok(loader.getPrompts().prompts.some(prompt => prompt.name === 'probe-prompt'))
  assert.ok(loader.getThemes().themes.some(theme => theme.name === 'probe-theme'))
  assert.ok(app.host.session.getAllTools().some(tool => tool.name === 'kinex_skill'))
  await app.host.session.prompt('/package-command')
  assert.ok(app.host.session.sessionManager.getEntries().some(entry => entry.customType === 'package-command-ran'))
  await app.host.session.prompt('/probe-prompt argument')
  assert.match(JSON.stringify(fake.requests.at(-1)), /PACKAGE_PROMPT argument/)
  assert.match(JSON.stringify(fake.requests.at(-1)), /Inspect package resource integration/)
  assert.match(JSON.stringify(fake.requests.at(-1)), /Kinex core Python:/)
  await app.host.session.prompt('/skill:package-probe')
  assert.match(JSON.stringify(fake.requests.at(-1)), /PACKAGE_SKILL_BODY/)
  await writeFile(path.join(dir, 'probe-prompt.md'), 'RELOADED_PACKAGE_PROMPT $1')
  await app.host.session.reload()
  await app.host.session.prompt('/probe-prompt changed')
  assert.match(JSON.stringify(fake.requests.at(-1)), /RELOADED_PACKAGE_PROMPT changed/)
  await assert.rejects(stat(path.join(cwd, '.kinex/python')), { code: 'ENOENT' })
})

for (const mode of ['ask', 'auto']) {
  test(`nested SDK tool calls preserve Kinex permissions and error results (${mode})`, async t => {
    const cwd = await workspace(t)
    const fake = await fakeProvider(t, isolation.root)
    await packageFixture(cwd, `export default pi => pi.registerTool({
      name: 'nested_probe', label: 'Nested probe', description: 'Test nested tools',
      parameters: { type: 'object', properties: {} },
      async execute(_id, _args, _signal, _update, ctx) {
        const result = await ctx.executeTool('write', { path: 'nested-written', content: 'NESTED_OK' })
        if (result.isError) return result
        return await ctx.executeTool('device', { deviceID: 'missing', action: 'read' })
      }
    })`)
    const app = await createApplication({ cwd, model: 'fake/test', mode })
    t.after(() => app.dispose())
    await bind(app)
    fake.steps.push({ tool: 'nested_probe' }, { text: 'done' })
    await app.host.session.prompt('Exercise nested calls')
    const result = app.host.session.agent.state.messages.find(message => message.role === 'toolResult')
    assert.equal(result.isError, true)
    if (mode === 'ask') {
      await assert.rejects(stat(path.join(cwd, 'nested-written')), { code: 'ENOENT' })
      assert.equal(fake.requests.length, 1, 'permission denial aborts the outer turn')
      assert.equal(result.nestedCalls.calls[0].status, 'error')
    } else {
      assert.equal(await readFile(path.join(cwd, 'nested-written'), 'utf8'), 'NESTED_OK')
      assert.match(JSON.stringify(result), /missing/)
      assert.equal(result.nestedCalls.calls.length, 2)
    }
  })
}

test('nested robotics calls retain recording attribution', async t => {
  const cwd = await workspace(t)
  const fake = await fakeProvider(t, isolation.root)
  await packageFixture(cwd, `export default pi => pi.registerTool({
    name: 'nested_device', label: 'Nested device', description: 'Test nested robotics',
    parameters: { type: 'object', properties: {} },
    async execute(_id, _args, _signal, _update, ctx) {
      return await ctx.executeTool('device', { deviceID: 'sensor', action: 'read' })
    }
  })`)
  const app = await createApplication({ cwd, model: 'fake/test', mode: 'auto' })
  t.after(() => app.dispose())
  await seed(app.owner.runtime)
  await bind(app)
  await app.host.session.prompt('/load sensor')
  await app.host.session.prompt('/record start sensor=2')
  fake.steps.push({ tool: 'nested_device' }, { text: 'recorded' })
  await app.host.session.prompt('Read sensor through a nested call')
  await app.host.session.prompt('/record stop success checked')
  const dirs = await readdir(path.join(cwd, '.kinex/recordings'))
  const trace = JSON.parse(await readFile(path.join(cwd, '.kinex/recordings', dirs[0], 'trace.json'), 'utf8'))
  const result = app.host.session.agent.state.messages.find(message => message.role === 'toolResult')
  assert.equal(result.nestedCalls.calls.length, 1)
  const recording = path.join(cwd, '.kinex/recordings', dirs[0])
  const timeline = (await readFile(path.join(recording, 'timeline.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  const events = (await readFile(path.join(recording, 'devices/sensor/events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  const id = result.nestedCalls.calls[0].id
  assert.ok(timeline.some(event => event.kind === 'tool.start' && event.callID === id))
  assert.ok(timeline.some(event => event.kind === 'tool.end' && event.callID === id))
  assert.ok(events.some(event => event.callID === id && event.action === 'read'))
  assert.match(JSON.stringify(trace), /recorded/)
})

test('cancelling a nested shell call terminates it and allows another turn', { timeout: 15000 }, async t => {
  const cwd = await workspace(t)
  const fake = await fakeProvider(t, isolation.root)
  await packageFixture(cwd, `export default pi => pi.registerTool({
    name: 'nested_sleep', label: 'Nested sleep', description: 'Test nested cancellation',
    parameters: { type: 'object', properties: {} },
    async execute(_id, _args, _signal, _update, ctx) {
      return await ctx.executeTool('bash', { command: 'sleep 30; echo unexpected > after-cancel' })
    }
  })`)
  const app = await createApplication({ cwd, model: 'fake/test', mode: 'auto' })
  t.after(() => app.dispose())
  await bind(app)
  let started
  const ready = new Promise(resolve => { started = resolve })
  const unsubscribe = app.host.session.subscribe(event => {
    if (event.type === 'tool_execution_start' && event.toolName === 'bash') started()
  })
  t.after(unsubscribe)
  fake.steps.push({ tool: 'nested_sleep' })
  const pending = app.host.session.prompt('Run nested sleep')
  await ready
  await app.host.session.abort()
  await pending
  await assert.rejects(stat(path.join(cwd, 'after-cancel')), { code: 'ENOENT' })
  fake.steps.push({ text: 'RECOVERED_NESTED' })
  await app.host.session.prompt('Continue')
  assert.match(JSON.stringify(app.host.session.agent.state.messages), /RECOVERED_NESTED/)
})

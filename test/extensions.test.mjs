import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import path from 'node:path'
import { setupPiExtensions } from '@kinex/setup/extensions'
import { isolate, fakeProvider, workspace, bind } from './helpers.mjs'

const isolation = await isolate()
after(isolation.cleanup)
const { createApplication } = await import('../dist/application.js')

function extension(name, text = 'EXTENSION_OK') {
  return `export default function (pi) {
    pi.registerTool({
      name: ${JSON.stringify(name)}, label: 'Extension test', description: 'Extension test tool',
      parameters: { type: 'object', properties: {} },
      async execute() { return { content: [{ type: 'text', text: ${JSON.stringify(text)} }], details: {} } }
    })
  }`
}

async function configure(file, extra) {
  await mkdir(path.dirname(file), { recursive: true })
  const existing = await readFile(file, 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error
    return '{}'
  })
  await writeFile(file, JSON.stringify({ ...JSON.parse(existing), ...extra }))
}

for (const configured of [false, true]) {
  test(`default web search and btw load and reload${configured ? ' with existing npm settings' : ''}`, async t => {
    const cwd = await workspace(t)
    const fake = await fakeProvider(t, isolation.root)
    if (configured) {
      const agent = path.join(isolation.root, 'config', 'agent')
      const modules = path.join(agent, 'npm', 'node_modules')
      await mkdir(modules, { recursive: true })
      for (const extension of setupPiExtensions()) {
        await symlink(extension.path, path.join(modules, extension.name))
      }
      await configure(path.join(agent, 'settings.json'), { packages: ['npm:pi-web-search', 'npm:pi-btw'] })
    }
    const app = await createApplication({ cwd, model: 'fake/test', mode: 'auto' })
    t.after(() => app.dispose())
    await bind(app)
    for (const reload of [false, true]) {
      if (reload) await app.host.session.reload()
      const tools = app.host.session.getAllTools().map(tool => tool.name)
      assert.equal(tools.filter(name => name === 'web_search').length, 1)
      assert.ok(tools.includes('url_context'))
      assert.ok(app.host.session.extensionRunner.getCommand('btw'))
      assert.ok(app.host.session.extensionRunner.getCommand('btw:ask'))
      await app.host.session.prompt('Reply briefly')
      const active = fake.requests.at(-1).tools.map(tool => tool.function.name)
      assert.ok(active.includes('web_search'))
      assert.ok(!active.includes('url_context'), 'URL context stays inactive for non-Gemini models')
    }
    const before = fake.requests.length
    await app.host.session.prompt('/btw:ask What is this workspace?')
    assert.ok(fake.requests.length > before, 'btw runs a child session using the configured provider')
    assert.ok(fake.requests.at(-1).tools.every(tool => ['read', 'grep', 'find', 'ls'].includes(tool.function.name)))
  })
}

for (const source of ['global-file', 'project-file', 'global-autoload', 'project-autoload', 'project-package']) {
  test(`Pi extension from ${source} executes alongside Kinex and survives reload`, async t => {
    const cwd = await workspace(t)
    const fake = await fakeProvider(t, isolation.root)
    const agent = path.join(isolation.root, 'config', 'agent')
    const directory = source === 'global-autoload' ? path.join(agent, 'extensions')
      : source === 'project-autoload' ? path.join(cwd, '.pi', 'extensions')
      : path.join(cwd, 'custom-extension')
    await mkdir(directory, { recursive: true })
    t.after(() => rm(directory, { recursive: true, force: true }))
    const file = path.join(directory, 'index.ts')
    await writeFile(file, extension('extension_probe'))
    if (source === 'global-file') await configure(path.join(agent, 'settings.json'), { extensions: [file] })
    if (source === 'project-file') await configure(path.join(cwd, '.kinex', 'agent', 'settings.json'), { extensions: [file] })
    if (source === 'project-package') {
      await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'kinex-extension-test', type: 'module', pi: { extensions: ['./index.ts'] } }))
      await configure(path.join(cwd, '.kinex', 'agent', 'settings.json'), { packages: [directory] })
    }
    const outputs = []
    const app = await createApplication({ cwd, model: 'fake/test', mode: 'auto', report: text => outputs.push(text) })
    t.after(() => app.dispose())
    await bind(app)
    await app.host.session.prompt('/devices')
    assert.ok(outputs.length, 'Kinex built-in command remains registered')
    fake.steps.push({ tool: 'extension_probe' }, { text: 'done' })
    await app.host.session.prompt('Use extension_probe')
    assert.ok(fake.requests[0].tools.some(tool => tool.function.name === 'extension_probe'))
    assert.ok(JSON.stringify(fake.requests[1]).includes('EXTENSION_OK'), 'tool result reaches the model')
    await writeFile(file, extension('extension_probe', 'RELOADED_EXTENSION_OK'))
    await app.host.session.reload()
    fake.steps.push({ tool: 'extension_probe' }, { text: 'done again' })
    await app.host.session.prompt('Use extension_probe again')
    assert.ok(JSON.stringify(fake.requests.at(-1)).includes('RELOADED_EXTENSION_OK'), 'updated tool result reaches the model after reload')
  })
}

test('broken extensions fail startup with their filename and error', async t => {
  const cwd = await workspace(t)
  await fakeProvider(t, isolation.root)
  const file = path.join(cwd, 'broken.mjs')
  await writeFile(file, 'export default function () { throw new Error("BROKEN_EXTENSION") }')
  await configure(path.join(cwd, '.kinex', 'agent', 'settings.json'), { extensions: [file] })
  await assert.rejects(createApplication({ cwd, model: 'fake/test' }), error => {
    assert.match(error.message, /broken\.mjs/)
    assert.match(error.message, /BROKEN_EXTENSION/)
    return true
  })
})

test('extension settings require arrays and unrelated resources remain disabled', async t => {
  const cwd = await workspace(t)
  await fakeProvider(t, isolation.root)
  const file = path.join(cwd, '.kinex', 'agent', 'settings.json')
  for (const key of ['extensions', 'packages', 'skills', 'prompts', 'themes']) {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify({ [key]: key === 'extensions' || key === 'packages' ? 'invalid' : ['unsupported'] }))
    await assert.rejects(createApplication({ cwd, model: 'fake/test' }), new RegExp(`${key} (must be an array|is not supported)`))
  }
})

test('SDK-default extension child sessions share Kinex OAuth credentials and auth locks', async t => {
  const cwd = await workspace(t)
  await fakeProvider(t, isolation.root)
  const state = path.join(isolation.root, 'data', 'agent')
  await mkdir(state, { recursive: true })
  const authFile = path.join(state, 'auth.json')
  const credential = { type: 'oauth', access: 'test-access', refresh: 'test-refresh', expires: Date.now() + 3600000 }
  await writeFile(authFile, JSON.stringify({ 'openai-codex': credential }))
  t.after(() => rm(authFile, { force: true }))
  const file = path.join(cwd, 'child-session.ts')
  await writeFile(file, `
    import assert from 'node:assert/strict'
    import { ModelRuntime, createAgentSession, DefaultResourceLoader, SessionManager, getAgentDir } from '@earendil-works/pi-coding-agent'
    import { AuthStorage } from '${new URL('../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js', import.meta.url).href}'
    import { lock } from '${new URL('../node_modules/proper-lockfile/index.js', import.meta.url).href}'
    import { join } from 'node:path'
    export default function (pi) {
      pi.registerCommand('probe-child-auth', {
        async handler(_args, ctx) {
          const model = ctx.modelRegistry.find('openai-codex', 'gpt-5.4') ?? ctx.modelRegistry.getAll().find(m => m.provider === 'openai-codex')
          assert.ok(model)
          const runtime = await ModelRuntime.create({ allowModelNetwork: false })
          const loader = new DefaultResourceLoader({ cwd: ctx.cwd, agentDir: getAgentDir(), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true })
          await loader.reload()
          const { session } = await createAgentSession({ cwd: ctx.cwd, model, sessionManager: SessionManager.inMemory(ctx.cwd), resourceLoader: loader, noTools: true })
          try {
            assert.equal((await runtime.getAuth(model)).auth.apiKey, 'test-access')
            assert.equal((await session.modelRuntime.getAuth(model)).auth.apiKey, 'test-access')
            assert.equal((await ctx.modelRegistry.getApiKeyAndHeaders(model)).apiKey, 'test-access')
            const auth = AuthStorage.create()
            const release = await lock(join(getAgentDir(), 'auth.json'), { realpath: false })
            let finished = false
            const update = auth.modify('openai-codex', current => ({ ...current, access: 'updated-test-access' })).then(() => { finished = true })
            try {
              await new Promise(resolve => setTimeout(resolve, 50))
              assert.equal(finished, false, 'SDK credential updates wait for the shared auth lock')
            } finally { await release() }
            await update
            assert.equal((await runtime.getAuth(model)).auth.apiKey, 'updated-test-access')
            assert.equal((await session.modelRuntime.getAuth(model)).auth.apiKey, 'updated-test-access')
            assert.equal((await ctx.modelRegistry.getApiKeyAndHeaders(model)).apiKey, 'updated-test-access')
            pi.appendEntry('child-auth-passed', {})
          } finally { session.dispose() }
        }
      })
    }
  `)
  await configure(path.join(cwd, '.kinex', 'agent', 'settings.json'), { extensions: [file] })
  const app = await createApplication({ cwd, model: 'fake/test' })
  t.after(() => app.dispose())
  await bind(app)
  await app.host.session.prompt('/probe-child-auth')
  assert.ok(app.host.session.sessionManager.getEntries().some(entry => entry.type === 'custom' && entry.customType === 'child-auth-passed'))
  assert.equal(JSON.parse(await readFile(authFile, 'utf8'))['openai-codex'].access, 'updated-test-access')
})

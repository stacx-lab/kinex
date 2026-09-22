import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { isolate, fakeProvider, workspace, seed } from '../../../test/helpers.mjs'
const isolation = await isolate()
after(isolation.cleanup)
const { createAgentSession, DefaultResourceLoader, SessionManager } = await import('@earendil-works/pi-coding-agent')
const { createPiExtension } = await import('../dist/index.js')
const { coreContribution } = await import('@kinex/core/integration')
const { executeCommand } = await import('../dist/commands.js')

async function fixture(t, contributions, uiContext) {
  const cwd = await workspace(t)
  const fake = await fakeProvider(t, isolation.root)
  const agentDir = path.join(isolation.root, 'config/agent')
  let runtime
  const factory = createPiExtension({ contributions: value => { runtime = value; return contributions?.(value) ?? [coreContribution(value)] } })
  const loader = new DefaultResourceLoader({ cwd, agentDir, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, extensionFactories: [{ name: 'kinex-test', factory }] })
  await loader.reload()
  const result = await createAgentSession({ cwd, agentDir, resourceLoader: loader, sessionManager: SessionManager.create(cwd, path.join(cwd, 'sessions')) })
  assert.deepEqual(result.extensionsResult.errors, [])
  await result.session.bindExtensions({ mode: uiContext ? 'interactive' : 'print', uiContext, onError: error => { throw new Error(error.error) } })
  t.after(async () => { await result.session.abort(); await runtime?.dispose(); result.session.dispose() })
  return { cwd, fake, session: result.session, get runtime() { return runtime } }
}

test('cancelling a Pi device removal confirmation preserves the device', async t => {
  const f = await fixture(t)
  await seed(f.runtime)
  const controller = new AbortController()
  const command = coreContribution(f.runtime).commands.find(command => command.name === 'unregister')
  await assert.rejects(executeCommand(command, 'sensor', {
    sessionManager: f.session.sessionManager, hasUI: true, signal: controller.signal,
    ui: { confirm: async (_title, _description, options) => {
      assert.equal(options.signal, controller.signal)
      controller.abort()
      return true
    } },
  }), { name: 'AbortError' })
  assert.equal((await f.runtime.devices.list())[0].name, 'sensor')
})

test('native Pi loads the extension and user device commands do not invoke the model', async t => {
  const f = await fixture(t)
  await seed(f.runtime)
  await f.session.prompt('/load sensor')
  assert.equal((await f.runtime.devices.list())[0].loaded, true)
  await f.session.prompt('/unload sensor')
  assert.equal((await f.runtime.devices.list())[0].loaded, false)
  await f.session.prompt('/devices')
  assert.equal(f.fake.requests.length, 0)
  await f.session.prompt('describe devices')
  assert.equal(f.fake.requests.length, 1)
  assert.match(JSON.stringify(f.fake.requests[0]), /kinex_context/)
})

test('native Pi updates the recording footer from manual commands and runtime completion events', async t => {
  let footer
  const base = { render: () => ['/workspace', 'model'], invalidate() {} }
  const tui = { children: [{ children: [base] }], requestRender() {} }
  const statuses = []
  const ui = {
    setWidget: (key, content) => { assert.equal(key, 'kinex-recording'); if (content) assert.deepEqual(content(tui).render(80), []) },
    setFooter: factory => { footer = factory?.(tui) },
    setStatus: (_key, text) => statuses.push(text),
    notify: message => assert.fail(message),
  }
  const f = await fixture(t, undefined, ui)
  await seed(f.runtime)
  await f.session.prompt('/load sensor')
  const waitForRecording = async active => {
    const visible = () => footer?.render(80)[0].includes('rec:') ?? false
    for (let i = 0; i < 100 && visible() !== active; i++) await delay(10)
    assert.equal(visible(), active)
  }
  await f.session.prompt('/record start sensor=2 native capture')
  await waitForRecording(true)
  assert.match(footer.render(80)[0], /^\/workspace +\x1b\[31mrec: native-capture/)
  await f.session.prompt('/record stop success')
  await waitForRecording(false)
  await f.runtime.recording.start({ specs: { sensor: { rate: 2 } }, instruction: 'quota capture', sessionID: f.session.sessionManager.getSessionId() })
  await waitForRecording(true)
  await f.runtime.recording.stop({ endedBy: 'quota' })
  await waitForRecording(false)
  await f.session.prompt('/record start missing=2')
  await waitForRecording(false)
  assert.equal(f.fake.requests.length, 0)
  assert.ok(statuses.every(text => !text.includes('REC')))
})

test('native Pi discovers a tool written during the task and preserves projected context across requests', async t => {
  const f = await fixture(t)
  f.fake.steps.push(
    { tool: 'write', args: { path: '.kinex/tool/fresh.ts', content: `export default {description:'fresh', execute:async()=>({title:'fresh',output:'FRESH_OK'})}` } },
    { tool: 'fresh', args: {} },
    { text: 'done' },
  )
  await f.session.prompt('Create and call the fresh tool')
  assert.equal(f.fake.requests.length, 3)
  assert.match(JSON.stringify(f.fake.requests[2]), /FRESH_OK/)
  const first = f.fake.requests[0].messages
  assert.deepEqual(f.fake.requests[1].messages.slice(0, first.length), first)
  f.session.settingsManager.applyOverrides({ compaction: { enabled: true, reserveTokens: 1024, keepRecentTokens: 1 } })
  await f.session.prompt('Prepare another turn for compaction')
  await f.session.compact('retain robotics')
  await f.session.prompt('continue')
  assert.match(JSON.stringify(f.fake.requests.at(-1)), /kinex_context/)
})

test('a second feature package contributes tools and commands through the same Pi adapter', async t => {
  const f = await fixture(t, runtime => [coreContribution(runtime), {
    id: 'world',
    tools: { list: async () => ({ tools: [{ name: 'world_setup', description: 'world setup', inputSchema: { type: 'object', properties: {} } }], problems: [] }), call: async () => ({ title: 'world', output: 'WORLD_OK' }) },
    commands: [{ name: 'world-status', arguments: '', description: 'world status', kind: 'operation', execute: async () => ({ kind: 'output', text: 'WORLD_STATUS' }) }],
    skills: { list: async () => [{ name: 'world-skill', description: 'world skill', file: '/world/SKILL.md', directory: '/world' }], load: async name => name === 'world-skill' ? { info: { name, directory: '/world' }, content: 'WORLD_SKILL_BODY' } : undefined },
    context: async () => ({ instructions: 'World instructions', sections: { status: 'WORLD_CONTEXT' } }),
  }])
  await f.session.prompt('/world-status')
  assert.equal(f.fake.requests.length, 0)
  f.fake.steps.push({ tool: 'world_setup', args: {} }, { text: 'done' })
  await f.session.prompt('set up the world')
  assert.match(JSON.stringify(f.fake.requests.at(-1)), /WORLD_OK/)
  assert.match(JSON.stringify(f.fake.requests[0]), /WORLD_CONTEXT/)
  f.fake.steps.push({ tool: 'kinex_skill', args: { name: 'world-skill' } }, { text: 'skill loaded' })
  await f.session.prompt('load the world skill')
  assert.match(JSON.stringify(f.fake.requests.at(-1)), /WORLD_SKILL_BODY/)
})

test('native Pi denies a robotics batch before later coding writes', async t => {
  const f = await fixture(t)
  await seed(f.runtime)
  f.fake.steps.push({ tools: [
    { name: 'device', args: { deviceID: 'sensor', action: 'load' } },
    { name: 'write', args: { path: 'must-not-exist', content: 'bad' } },
  ] })
  await f.session.prompt('load the sensor then write')
  assert.equal(f.fake.requests.length, 1)
  assert.equal((await f.runtime.devices.list())[0].loaded, false)
  const { stat } = await import('node:fs/promises')
  await assert.rejects(stat(path.join(f.cwd, 'must-not-exist')), { code: 'ENOENT' })
})

test('native Pi blocks the next request when a feature snapshot fails, and recovers on a later prompt', async t => {
  let fail = false
  const f = await fixture(t, runtime => [coreContribution(runtime), {
    id: 'world', context: async () => { if (fail) throw new Error('snapshot unavailable'); return { instructions: '', sections: { state: 'ready' } } },
  }])
  f.fake.respond = async () => { fail = true; return { tool: 'read', args: { path: 'missing' } } }
  await f.session.prompt('read').catch(error => assert.match(String(error), /snapshot unavailable|abort/i))
  assert.equal(f.fake.requests.length, 1)
  fail = false
  f.fake.respond = undefined
  await f.session.prompt('retry after repair')
  assert.equal(f.fake.requests.length, 2)
})

test('native Pi factory handoff retains a same-workspace runtime and disposes it on workspace change/reload', async t => {
  const { createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices } = await import('@earendil-works/pi-coding-agent')
  const cwd = await workspace(t)
  await fakeProvider(t, isolation.root)
  const agentDir = path.join(isolation.root, 'config/agent')
  let cachedCwd
  let factory
  let runtime
  const host = await createAgentSessionRuntime(async ({ cwd, sessionManager, sessionStartEvent }) => {
    // Native Pi caches factories within a cwd, then recreates them across cwd changes.
    if (cachedCwd !== cwd) {
      cachedCwd = cwd
      factory = createPiExtension({ contributions: value => { runtime = value; return [coreContribution(value)] } })
    }
    const services = await createAgentSessionServices({ cwd, agentDir, resourceLoaderOptions: { noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, extensionFactories: [{ name: 'kinex-native', factory }] } })
    return { ...await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent }), services, diagnostics: services.diagnostics }
  }, { cwd, agentDir, sessionManager: SessionManager.create(cwd, path.join(cwd, 'sessions')) })
  t.after(() => host.dispose())
  const bind = () => host.session.bindExtensions({ mode: 'print', onError: error => { throw new Error(error.error) } })
  host.setRebindSession(bind)
  await bind()
  await seed(runtime)
  await host.session.prompt('/load sensor')
  await host.session.prompt('/record start sensor=2')
  const original = runtime
  await host.newSession()
  assert.equal(runtime, original)
  assert.equal((await runtime.devices.list())[0].loaded, true)
  assert.equal(await runtime.recording.status(), undefined)
  await host.session.reload()
  assert.notEqual(runtime, original)
  assert.throws(() => original.devices.list(), /disposed/)
  const beforeSwitch = runtime
  const target = await fixture(t)
  await target.session.prompt('create target history')
  await host.switchSession(target.session.sessionFile)
  assert.throws(() => beforeSwitch.devices.list(), /disposed/)
  assert.equal(runtime.directory, target.cwd)
})

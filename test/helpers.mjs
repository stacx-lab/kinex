import { protocolDevice, protocolFramePython } from '../packages/core/test/fixtures/protocol.mjs'
import { useUv } from '../packages/core/test/fixtures/python.mjs'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

export async function isolate() {
  const root = await mkdtemp(path.join(tmpdir(), 'kinex-sdk-'))
  process.env.KINEX_CONFIG_DIR = path.join(root, 'config')
  await useUv(process.env.KINEX_CONFIG_DIR)
  process.env.KINEX_DATA_DIR = path.join(root, 'data')
  process.env.PI_CODING_AGENT_DIR = path.join(root, 'config', 'agent')
  process.env.PI_SKIP_VERSION_CHECK = '1'
  process.env.PI_TELEMETRY = '0'
  for (const name of Object.keys(process.env)) if (name.endsWith('API_KEY') || name.endsWith('API_TOKEN')) delete process.env[name]
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) }
}

// Self-improve runs its workers and distillers only in a sandbox. Where neither bubblewrap nor
// Docker can start one, children of these tests run under a stand-in bubblewrap that does not
// isolate them. The check runs in a process of its own, which caches its answer, not in this one.
export async function sandboxOrStandIn() {
  // A sandbox binds the Kinex its children run, which the check names as a Kinex process would.
  const entry = fileURLToPath(new URL('../bin/kinex.mjs', import.meta.url))
  const check = `const { kinex } = await import('@kinex/self-improve/common/kinex'); kinex.entry = ${JSON.stringify(entry)}; await (await import('@kinex/self-improve/common/sandbox')).sandboxOf()`
  const root = fileURLToPath(new URL('../', import.meta.url))
  const real = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', check], { cwd: root }).then(() => true, () => false)
  if (!real) process.env.PATH = [fileURLToPath(new URL('./fixtures/sandbox', import.meta.url)), process.env.PATH].join(path.delimiter)
  return real
}

export async function fakeProvider(t, root) {
  const requests = []
  const steps = []
  const fake = { requests, steps, respond: undefined }
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const request = JSON.parse(body)
    requests.push(request)
    const step = steps.shift() ?? await fake.respond?.(request) ?? { text: 'FAKE_REPLY_OK' }
    if (step.status) { res.writeHead(step.status); res.end(step.body ?? 'retry'); return }
    if (step.wait) { await step.wait; if (res.destroyed) return }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const base = { id: `response-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: 'test' }
    const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
    if (step.tool || step.tools) {
      const calls = step.tools ?? [{ name: step.tool, args: step.args }]
      send({ role: 'assistant', ...(step.text ? { content: step.text } : {}), tool_calls: calls.map((call, index) => ({ index, id: `call_${requests.length}_${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) } })) })
      send({}, 'tool_calls')
    } else { send({ role: 'assistant', content: step.text ?? 'FAKE_REPLY_OK' }); send({}, 'stop') }
    res.write(`data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: step.inputTokens ?? 1000, completion_tokens: 20, total_tokens: (step.inputTokens ?? 1000) + 20, prompt_tokens_details: { cached_tokens: 800 } } })}\n\ndata: [DONE]\n\n`)
    res.end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  const config = path.join(root, 'config', 'agent')
  await mkdir(config, { recursive: true })
  await writeFile(path.join(config, 'models.json'), JSON.stringify({ providers: { fake: {
    api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fake-only',
    models: [{ id: 'test', name: 'Fake', input: ['text', 'image'], contextWindow: 128000, maxTokens: 4096, reasoning: false }],
  } } }))
  await writeFile(path.join(config, 'settings.json'), JSON.stringify({ defaultProvider: 'fake', defaultModel: 'test', cacheWarming: 'off', retry: { enabled: true, baseDelayMs: 1, maxRetries: 1, provider: { maxRetries: 0 } } }))
  return fake
}

export async function workspace(t) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'kinex-workspace-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  return cwd
}

export async function bind(app, uiContext) {
  await app.host.session.bindExtensions({ mode: uiContext ? 'interactive' : 'print', uiContext, onError: error => { throw new Error(error.error) } })
}

export async function seed(core, name = 'sensor', { preparePython = true } = {}) {
  if (preparePython) await protocolFramePython(core)
  await core.profiles.writeManifest({ identity: { id: 'test', name: 'Test', kind: 'arm' } })
  await protocolDevice(core, path.dirname(path.dirname((await core.python.status()).project)), name)
}

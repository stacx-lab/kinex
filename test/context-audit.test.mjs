import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isolate, workspace, fakeProvider, bind, seed } from './helpers.mjs'

const isolation = await isolate()
after(isolation.cleanup)
const { createApplication } = await import('../dist/application.js')

// Compare model-visible content, excluding Anthropic's moving cache breakpoint.
const normalized = value => JSON.parse(JSON.stringify(value, (key, item) => key === 'cache_control' ? undefined : item))
const messages = request => normalized(request.messages ?? request.input)

async function wireProvider(t, api, { compat, steps = [] } = {}) {
  const requests = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    requests.push(JSON.parse(body))
    const step = steps.shift() ?? { text: 'AUDIT_REPLY' }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = data => res.write(`data: ${JSON.stringify(data)}\n\n`)
    if (api === 'anthropic-messages') {
      const event = data => { res.write(`event: ${data.type}\n`); send(data) }
      event({ type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', model: 'test', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 0 } } })
      event({ type: 'content_block_start', index: 0, content_block: step.tool
        ? { type: 'tool_use', id: `call_${requests.length}`, name: step.tool, input: {} }
        : { type: 'text', text: '' } })
      event({ type: 'content_block_delta', index: 0, delta: step.tool
        ? { type: 'input_json_delta', partial_json: JSON.stringify(step.args ?? {}) }
        : { type: 'text_delta', text: step.text } })
      event({ type: 'content_block_stop', index: 0 })
      event({ type: 'message_delta', delta: { stop_reason: step.tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } })
      event({ type: 'message_stop' })
    } else if (api === 'openai-responses') {
      const id = `resp_${requests.length}`
      const item = step.tool
        ? { id: `fc_${requests.length}`, call_id: `call_${requests.length}`, type: 'function_call', name: step.tool, arguments: JSON.stringify(step.args ?? {}), status: 'completed' }
        : { id: `msg_${requests.length}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: step.text, annotations: [] }] }
      send({ type: 'response.created', response: { id, status: 'in_progress', output: [] } })
      send({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } })
      if (step.tool) send({ type: 'response.function_call_arguments.delta', output_index: 0, delta: item.arguments })
      else {
        send({ type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
        send({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: step.text })
      }
      send({ type: 'response.output_item.done', output_index: 0, item })
      send({ type: 'response.completed', response: { id, status: 'completed', output: [item], usage: { input_tokens: 1000, output_tokens: 10, total_tokens: 1010 } } })
    } else {
      const chunk = { id: 'chat_test', object: 'chat.completion.chunk', model: 'test', created: 1 }
      const delta = step.tool
        ? { role: 'assistant', tool_calls: [{ index: 0, id: `call_${requests.length}`, type: 'function', function: { name: step.tool, arguments: JSON.stringify(step.args ?? {}) } }] }
        : { role: 'assistant', content: step.text }
      send({ ...chunk, choices: [{ index: 0, delta, finish_reason: null }] })
      send({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: step.tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010 } })
      res.write('data: [DONE]\n\n')
    }
    res.end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  const directory = path.join(isolation.root, 'config/agent')
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, 'models.json'), JSON.stringify({ providers: { fake: {
    api, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fake-only',
    models: [{ id: 'test', name: 'Audit', input: ['text', 'image'], contextWindow: 128000, maxTokens: 4096, reasoning: false, compat }],
  } } }))
  await writeFile(path.join(directory, 'settings.json'), JSON.stringify({ defaultProvider: 'fake', defaultModel: 'test', cacheWarming: 'off', retry: { enabled: false } }))
  return requests
}

for (const api of ['openai-completions', 'openai-responses', 'anthropic-messages']) {
  test(`${api}: full request prefixes survive device/skill state changes and session reopen`, async t => {
    const cwd = await workspace(t)
    const requests = await wireProvider(t, api)
    const app = await createApplication({ cwd, model: 'fake/test', mode: 'auto' })
    t.after(() => app.dispose())
    await seed(app.owner.runtime)
    await bind(app)
    await app.host.session.prompt('baseline')
    await app.host.session.prompt('/load sensor')
    await app.host.session.prompt('loaded')
    const skillDir = path.join(cwd, '.kinex/skills/new-audit-skill')
    await mkdir(skillDir, { recursive: true })
    await writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: new-audit-skill\ndescription: Unique new audit skill\n---\nFresh skill body')
    await app.host.session.prompt('skill added')
    await app.host.session.prompt('/unload sensor')
    await app.host.session.prompt('unloaded')
    const session = app.host.session.sessionFile
    await app.dispose()
    const resumed = await createApplication({ cwd, session, model: 'fake/test', mode: 'auto' })
    t.after(() => resumed.dispose())
    await bind(resumed)
    await resumed.host.session.prompt('resumed')
    assert.equal(requests.length, 5)
    assert.doesNotMatch(JSON.stringify(requests[0]), /new-audit-skill/)
    assert.match(JSON.stringify(requests[2]), /new-audit-skill/)
    for (let index = 1; index < requests.length; index++) {
      const previous = requests[index - 1]
      const current = requests[index]
      assert.deepEqual(current.tools, requests[0].tools, `tool prefix changed at ${index}`)
      assert.deepEqual(current.system, requests[0].system, `system changed at ${index}`)
      assert.deepEqual(current.instructions, requests[0].instructions, `instructions changed at ${index}`)
      const prefix = messages(previous)
      assert.deepEqual(messages(current).slice(0, prefix.length), prefix, `history prefix changed at ${index}`)
      assert.equal(current.prompt_cache_key, requests[0].prompt_cache_key)
    }
    if (api === 'openai-responses') assert.ok(requests[0].prompt_cache_key)
  })
}

test('same-task discovery: new tools and skill catalogs appear on the next request', async t => {
  const cwd = await workspace(t)
  const fake = await fakeProvider(t, isolation.root)
  const app = await createApplication({ cwd, model: 'fake/test', mode: 'auto' })
  t.after(() => app.dispose())
  await bind(app)
  const skill = '---\nname: instant-skill\ndescription: Instant new skill\n---\nSKILL_BODY_V1'
  fake.steps.push(
    { tool: 'write', args: { path: '.kinex/tools/instant_tool.ts', content: `export default {description:'Instant',execute:async()=>({title:'instant',output:'INSTANT_TOOL_OK'})}` } },
    { tool: 'instant_tool' },
    { tool: 'write', args: { path: '.kinex/skills/instant-skill/SKILL.md', content: skill } },
    { tool: 'skill', args: { name: 'instant-skill' } },
    { tool: 'write', args: { path: '.kinex/skills/instant-skill/SKILL.md', content: skill.replace('V1', 'V2') } },
    { tool: 'skill', args: { name: 'instant-skill' } },
    { text: 'done' },
  )
  await app.host.session.prompt('create a tool and a skill')
  assert.equal(fake.requests.length, 7, 'context refresh must not trigger an extra response')
  assert.ok(!fake.requests[0].tools.some(tool => tool.function.name === 'instant_tool'))
  for (const request of fake.requests.slice(1)) assert.ok(request.tools.some(tool => tool.function.name === 'instant_tool'))
  assert.match(JSON.stringify(fake.requests[2]), /INSTANT_TOOL_OK/)
  const skillContext = fake.requests[3].messages.findLast(message => JSON.stringify(message).includes('<kinex_context>'))
  assert.match(JSON.stringify(skillContext), /instant-skill/)
  assert.match(JSON.stringify(fake.requests[4]), /SKILL_BODY_V1/)
  assert.match(JSON.stringify(fake.requests[6]), /SKILL_BODY_V2/)
  const contexts = app.host.session.sessionManager.getBranch().filter(entry => entry.type === 'custom_message' && entry.customType === 'kinex-context')
  assert.equal(contexts.length, 3, 'only the initial snapshot, new workspace content root and skill catalog are emitted')
  assert.doesNotMatch(contexts[0].content, /instant-skill/)
  assert.match(contexts[1].content, /guides:/)
  assert.match(contexts[2].content, /instant-skill/)
  for (let index = 2; index < fake.requests.length; index++) {
    assert.deepEqual(fake.requests[index].tools, fake.requests[1].tools)
    const prefix = messages(fake.requests[index - 1])
    assert.deepEqual(messages(fake.requests[index]).slice(0, prefix.length), prefix)
  }
})

for (const profile of [
  { name: 'Responses additional_tools', api: 'openai-responses', compat: { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true } },
  { name: 'Responses tool search', api: 'openai-responses', compat: { supportsMidConvoSystemMessages: true, supportsToolSearch: true } },
  { name: 'Completions native additions', api: 'openai-completions', compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolAdditions: true } },
  { name: 'Anthropic inline tool definitions', api: 'anthropic-messages', compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true } },
  { name: 'Responses fallback', api: 'openai-responses' },
]) {
  test(`${profile.name}: tool changes execute correctly and preserve the prior request prefix`, async t => {
    const cwd = await workspace(t)
    const file = '.kinex/tools/late.ts'
    const source = version => `export default {description:'Late interface ${version}',execute:async()=>({title:'late',output:'LATE_${version}'})}`
    const requests = await wireProvider(t, profile.api, { compat: profile.compat, steps: [
      { tool: 'write', args: { path: file, content: source('V1') } },
      { tool: 'late' },
      { tool: 'bash', args: { command: 'rm .kinex/tools/late.ts' } },
      { tool: 'write', args: { path: file, content: source('V2') } },
      { tool: 'late' },
      { text: 'done' },
    ] })
    const app = await createApplication({ cwd, model: 'fake/test', mode: 'auto' })
    t.after(() => app.dispose())
    await bind(app)
    await app.host.session.prompt('create, use, remove and redefine a tool')
    assert.equal(requests.length, 6)
    assert.match(JSON.stringify(messages(requests[2]).at(-1)), /LATE_V1/)
    assert.match(JSON.stringify(messages(requests[5]).at(-1)), /LATE_V2/)
    const tool = (request, name) => request.tools.find(tool => (tool.function?.name ?? tool.name) === name)
    if (profile.compat) assert.deepEqual(requests[1].tools.slice(0, requests[0].tools.length), requests[0].tools)
    for (const index of [1, 2]) {
      const prefix = messages(requests[index - 1])
      assert.deepEqual(messages(requests[index]).slice(0, prefix.length), prefix)
      assert.deepEqual(requests[index].system, requests[0].system)
      assert.equal(requests[index].prompt_cache_key, requests[0].prompt_cache_key)
    }
    let redefined = tool(requests[4], 'late')
    if (profile.api === 'anthropic-messages') {
      // Pi 1.1 defines additions/redefinitions in history, keeping the initial
      // tool list and every preceding message stable even across removals.
      const additions = messages(requests[4]).flatMap(message => Array.isArray(message.content) ? message.content : [])
        .filter(block => block.type === 'tool_addition' && block.tool.type === 'tool_definition')
        .map(block => block.tool.definition)
      assert.deepEqual(additions.filter(tool => tool.name === 'late').map(tool => tool.description), ['Late interface V1', 'Late interface V2'])
      redefined = additions.findLast(tool => tool.name === 'late')
      for (let index = 1; index < requests.length; index++) {
        assert.deepEqual(requests[index].tools, requests[0].tools)
        const prefix = messages(requests[index - 1])
        assert.deepEqual(messages(requests[index]).slice(0, prefix.length), prefix)
      }
    }
    assert.ok(redefined, 'updated definition is sent to the provider')
    assert.equal((redefined.function ?? redefined).description, 'Late interface V2')
  })
}

test('same-task tool implementation edits take effect without changing the tool declaration', async t => {
  const cwd = await workspace(t)
  const fake = await fakeProvider(t, isolation.root)
  const directory = path.join(cwd, '.kinex/tools')
  await mkdir(directory, { recursive: true })
  const source = version => `export default {description:'Stable description',execute:async()=>({title:'stable',output:'IMPLEMENTATION_${version}'})}`
  await writeFile(path.join(directory, 'stable_tool.ts'), source('V1'))
  const app = await createApplication({ cwd, model: 'fake/test', mode: 'auto' })
  t.after(() => app.dispose())
  await bind(app)
  fake.steps.push(
    { tool: 'stable_tool' },
    { tool: 'write', args: { path: '.kinex/tools/stable_tool.ts', content: source('V2') } },
    { tool: 'stable_tool' },
    { text: 'done' },
  )
  await app.host.session.prompt('update and call the tool again')
  assert.equal(fake.requests.length, 4)
  assert.match(JSON.stringify(fake.requests[1]), /IMPLEMENTATION_V1/)
  const lastResult = fake.requests[3].messages.findLast(message => message.role === 'tool')
  assert.match(JSON.stringify(lastResult), /IMPLEMENTATION_V2/)
  for (let index = 1; index < fake.requests.length; index++) {
    assert.deepEqual(fake.requests[index].tools, fake.requests[0].tools)
    const prefix = messages(fake.requests[index - 1])
    assert.deepEqual(messages(fake.requests[index]).slice(0, prefix.length), prefix)
  }
})

test('same-task tool interface edits, discovery errors, recovery and deletion refresh the active tools', async t => {
  const cwd = await workspace(t)
  const fake = await fakeProvider(t, isolation.root)
  const directory = path.join(cwd, '.kinex/tools')
  await mkdir(directory, { recursive: true })
  const file = '.kinex/tools/changing.ts'
  await writeFile(path.join(cwd, file), `export default {description:'Original interface',execute:async()=>({title:'old',output:'old'})}`)
  const updated = `import { z } from ${JSON.stringify(import.meta.resolve('zod'))}; export default {
    description:'Updated interface',parameters:z.object({value:z.string()}),
    execute:async(args)=>({title:'new',output:'UPDATED:'+args.value})
  }`
  const app = await createApplication({ cwd, model: 'fake/test', mode: 'auto' })
  t.after(() => app.dispose())
  await bind(app)
  fake.steps.push(
    { tool: 'write', args: { path: file, content: updated } },
    { tool: 'changing', args: { value: 'FIRST' } },
    { tool: 'write', args: { path: file, content: `throw new Error('BROKEN_TOOL_DISCOVERY')` } },
    { tool: 'write', args: { path: file, content: updated } },
    { tool: 'changing', args: { value: 'RECOVERED' } },
    { tool: 'bash', args: { command: 'rm .kinex/tools/changing.ts' } },
    { text: 'done' },
  )
  await app.host.session.prompt('update, break, repair and remove a tool')
  assert.equal(fake.requests.length, 7)
  const declaration = index => fake.requests[index].tools.find(tool => tool.function.name === 'changing')?.function
  assert.equal(declaration(0).description, 'Original interface')
  assert.equal(declaration(1).description, 'Updated interface')
  assert.equal(declaration(1).parameters.properties.value.type, 'string')
  assert.match(JSON.stringify(fake.requests[2].messages.at(-1)), /UPDATED:FIRST/)
  assert.equal(declaration(3), undefined)
  assert.match(JSON.stringify(fake.requests[3].messages.at(-1)), /BROKEN_TOOL_DISCOVERY/)
  assert.deepEqual(declaration(4), declaration(1))
  assert.match(JSON.stringify(fake.requests[4].messages.at(-1)), /problems:\\n\(none\)/)
  assert.match(JSON.stringify(fake.requests[5].messages.at(-1)), /UPDATED:RECOVERED/)
  assert.equal(declaration(6), undefined)
})

test('a batch refresh appends context after every tool result and does not duplicate unchanged snapshots', async t => {
  const cwd = await workspace(t)
  const fake = await fakeProvider(t, isolation.root)
  const app = await createApplication({ cwd, model: 'fake/test', mode: 'auto' })
  t.after(() => app.dispose())
  await bind(app)
  fake.steps.push(
    { tools: [
      { name: 'write', args: { path: '.kinex/skills/batch-skill/SKILL.md', content: '---\nname: batch-skill\ndescription: Batch skill\n---\nBODY' } },
      { name: 'write', args: { path: '.kinex/tools/batch_tool.ts', content: `export default {description:'Batch tool',execute:async()=>({title:'batch',output:'BATCH_OK'})}` } },
    ] },
    { tool: 'batch_tool' },
    { text: 'done' },
  )
  await app.host.session.prompt('create tools and skills in a batch')
  assert.equal(fake.requests.length, 3)
  const next = fake.requests[1]
  assert.ok(next.tools.some(tool => tool.function.name === 'batch_tool'))
  const callIndex = next.messages.findLastIndex(message => message.tool_calls?.length === 2)
  const calls = next.messages[callIndex].tool_calls
  const results = next.messages.slice(callIndex + 1, callIndex + 3)
  assert.deepEqual(results.map(result => result.tool_call_id).sort(), calls.map(call => call.id).sort())
  assert.ok(results.every(result => result.role === 'tool'))
  assert.match(JSON.stringify(next.messages[callIndex + 3]), /<kinex_context>[\s\S]*batch-skill/)
  assert.match(JSON.stringify(fake.requests[2].messages.at(-1)), /BATCH_OK/)
  const contexts = app.host.session.sessionManager.getBranch().filter(entry => entry.type === 'custom_message' && entry.customType === 'kinex-context')
  assert.equal(contexts.length, 2)
})

test('headless CLI discovers and executes a new tool with stdin closed', { timeout: 15000 }, async t => {
  const cwd = await workspace(t)
  const fake = await fakeProvider(t, isolation.root)
  fake.steps.push(
    { tool: 'write', args: { path: '.kinex/tools/headless.ts', content: `export default {description:'Headless tool',execute:async()=>({title:'headless',output:'HEADLESS_TOOL_OK'})}` } },
    { tool: 'headless' },
    { text: 'HEADLESS_FINISHED' },
  )
  const entry = fileURLToPath(new URL('../bin/kinex.mjs', import.meta.url))
  const child = spawn(process.execPath, [entry, '-p', '--auto', '--model', 'fake/test', 'create and use a tool'], { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', data => { stdout += data })
  child.stderr.on('data', data => { stderr += data })
  assert.deepEqual(await once(child, 'close'), [0, null], stderr)
  assert.match(stdout, /HEADLESS_FINISHED/)
  assert.equal(fake.requests.length, 3)
  assert.ok(fake.requests[1].tools.some(tool => tool.function.name === 'headless'))
  assert.match(JSON.stringify(fake.requests[2].messages.at(-1)), /HEADLESS_TOOL_OK/)
})

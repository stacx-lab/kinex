import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
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

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stripTerminalSequences, visibleWidth, getCapabilities, setCapabilities } from '@earendil-works/pi-tui'
import { initTheme } from '@earendil-works/pi-coding-agent'
import { toolRenderers } from '../dist/render.js'
import { toolBridge, piResult } from '../dist/tools.js'
import { recordingIndicator, recordingFooter } from '../dist/recording-indicator.js'

const theme = { fg: (_color, text) => text, bold: text => text }
const context = { expanded: false, args: {}, isError: false }
const plain = component => component.render(100).map(stripTerminalSequences).join('\n').trim()
initTheme('dark', false)

test('important tools show action and target, including streamed arguments and aliases', async () => {
  for (const [name, args, expected] of [
    ['device', { deviceID: 'arm', action: 'write', args: { target: [1, 2] } }, 'device write arm'],
    ['device', { deviceID: 'camera' }, 'device read camera'],
    ['record', { action: 'start', devices: { arm: 10, camera: 2 } }, 'record start arm=10Hz camera=2Hz'],
    ['record', { action: 'snap', devices: ['arm', 'camera'] }, 'record snap arm, camera'],
    ['device_stop', {}, 'device_stop all'],
    ['move_to', { device: 'arm', joints: [1, 2] }, 'move_to arm joints'],
    ['drive', { device: 'base', mode: 'walk' }, 'drive base walk'],
    ['track', { control: { args: { device: 'arm' } }, perceive: { tool: 'observe' } }, 'track arm observe'],
  ]) assert.equal(plain(toolRenderers(name).renderCall(args, theme, context)), expected)
  for (const args of [undefined, null, {}, { devices: { arm: null } }]) {
    assert.doesNotThrow(() => plain(toolRenderers('record').renderCall(args, theme, context)))
  }
  const registered = []
  const bridge = toolBridge({
    getAllTools: () => [{ name: 'device' }], registerTool: tool => registered.push(tool),
  }, { tools: { list: async () => ({ problems: [], tools: [{ name: 'device', description: '', inputSchema: {} }] }) } }, {}, true)
  await bridge.refresh(true)
  assert.equal(plain(registered[0].renderCall({ deviceID: 'arm' }, theme, context)), 'kinex_device read arm')
  assert.equal(plain(toolRenderers('unknown_custom_tool').renderCall({}, theme, context)), 'unknown_custom_tool')
})

test('all Kinex tools share JSON result formatting regardless of argument-summary support', () => {
  const value = { observation: { pose: { position: [1, 2, 3] } } }
  const expected = '{\n  "observation": {\n    "pose": {"position":[1,2,3]}\n  }\n}'
  for (const name of ['observe', 'relative_pose', 'locate_object_3d', 'run_policy', 'workspace_tool']) {
    const result = { content: [{ type: 'text', text: JSON.stringify(value, null, 4) }] }
    assert.equal(plain(toolRenderers(name).renderResult(result, { expanded: true }, theme, context)).split('\n').map(line => line.trimEnd()).join('\n'), expected)
    assert.equal(plain(toolRenderers(name).renderResult({ content: [{ type: 'text', text: 'plain text result' }] }, { expanded: true }, theme, context)), 'plain text result')
  }
})

test('tool expansion reveals arguments and results, while collapsed views bound visual lines', async t => {
  const renderers = toolRenderers('device')
  const args = { action: 'write', deviceID: 'arm', args: { target: [0, 1, 2], for_s: 1 } }
  const expanded = plain(renderers.renderCall(args, theme, { ...context, expanded: true }))
  assert.match(expanded, /"target": \[0,1,2\]/)
  assert.match(expanded, /"for_s": 1/)
  const narrow = renderers.renderCall({ deviceID: 'camera'.repeat(10) }, theme, context).render(20)
  assert.equal(narrow.length, 1)
  assert.ok(visibleWidth(narrow[0]) <= 20)
  const result = await piResult({ title: 'result', output: JSON.stringify({ state: { data: Array.from({ length: 100 }, (_, i) => i), end: 'END_OF_RESULT' } }) })
  const before = structuredClone(result)
  const preview = renderers.renderResult(result, { expanded: false }, theme, context).render(25)
  assert.equal(preview.length, 5)
  assert.match(preview.at(-1), /expand/)
  const full = plain(renderers.renderResult(result, { expanded: true }, theme, context))
  assert.match(full, /END_OF_RESULT/)
  assert.deepEqual(result, before)
  const colors = []
  renderers.renderResult({ content: [{ type: 'text', text: 'driver failed' }] }, { expanded: true }, {
    ...theme, fg: (color, text) => { colors.push(color); return text },
  }, { ...context, isError: true })
  assert.deepEqual(colors, ['error'])
  const image = { type: 'image', mimeType: 'image/png', data: 'image-bytes' }
  const withImage = { content: [...result.content, image] }
  assert.match(plain(renderers.renderResult(withImage, { expanded: true }, theme, context)), /image\/png/)
  const capabilities = getCapabilities()
  t.after(() => setCapabilities(capabilities))
  setCapabilities({ ...capabilities, images: 'kitty' })
  assert.doesNotMatch(plain(renderers.renderResult(withImage, { expanded: true }, theme, { ...context, showImages: true })), /image\/png/)
  assert.equal(withImage.content.at(-1), image)
  assert.equal(plain(renderers.renderResult({ content: [{ type: 'text', text: '\x1b[2Jdriver error' }] }, { expanded: true }, theme, context)), 'driver error')
  assert.equal(plain(renderers.renderResult({ content: [{ type: 'text', text: '{"state":{"position":[1,2]}}' }] }, { expanded: true }, theme, { ...context, args: { compact: true } })), '{"state":{"position":[1,2]}}')
})

test('recording shares the directory row and preserves every other upstream footer line', () => {
  let name = 'test recording'
  const lines = ['/workspace (main) • session', '↑1000 ↓20 CH80% 0.8%/128k (auto)     test-model', 'Kinex · 1/1 devices · auto']
  const footer = recordingFooter({ render: () => lines, invalidate() {} }, () => name)
  for (const width of [15, 40, 100]) {
    const rendered = footer.render(width)
    assert.equal(rendered.length, lines.length)
    assert.deepEqual(rendered.slice(1), lines.slice(1))
    const first = stripTerminalSequences(rendered[0])
    assert.equal(visibleWidth(first), width)
    assert.match(first, /^\/.*rec:/)
    if (width === 100) assert.match(first, /^\/workspace \(main\) • session +rec: test recording$/)
  }
  name = undefined
  assert.deepEqual(footer.render(100), lines)
})

test('recording footer rejects stale updates and restores the host footer on shutdown', async () => {
  let listener
  const pending = []
  const widgets = []
  let component
  const base = { render: () => ['/workspace', 'model'], invalidate() {} }
  const tui = { children: [{ children: [base] }], requestRender() {} }
  const runtime = {
    subscribe: callback => { listener = callback; return () => { listener = undefined } },
    recording: { status: () => new Promise(resolve => pending.push(resolve)) },
  }
  const ctx = { hasUI: true, ui: {
    setWidget: (...args) => { widgets.push(args); if (args[1]) assert.deepEqual(args[1](tui).render(100), []) },
    setFooter: factory => { component = factory?.(tui) },
    notify: message => assert.fail(message),
  } }
  const indicator = recordingIndicator()
  const binding = indicator.bind(runtime, ctx)
  pending.shift()({ status: 'recording', name: 'test recording' })
  await binding
  assert.equal(widgets.at(-1)[1], undefined)
  assert.match(component.render(40)[0], /\x1b\[31mrec: test recording/)
  assert.equal(component.render(40).length, 2)
  listener({ type: 'recording.changed' })
  listener({ type: 'recording.changed' })
  const stale = pending.shift()
  pending.shift()(undefined)
  await Promise.resolve()
  assert.deepEqual(component.render(40), base.render(40))
  stale({ status: 'recording', name: 'stale' })
  await Promise.resolve()
  assert.deepEqual(component.render(40), base.render(40))
  listener({ type: 'recording.changed' })
  indicator.clear()
  pending.shift()({ status: 'recording', name: 'outgoing session' })
  await Promise.resolve()
  assert.equal(component, undefined)
  assert.equal(listener, undefined)
  await indicator.bind(runtime, { hasUI: false })
  assert.equal(pending.length, 0)
})

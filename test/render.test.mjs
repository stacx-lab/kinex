import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stripTerminalSequences, truncateToWidth, visibleWidth, getCapabilities, setCapabilities } from '@earendil-works/pi-tui'
import { initTheme } from '@earendil-works/pi-coding-agent'
import { toolRenderers } from '../dist/integration/render.js'
import { toolBridge, piResult } from '../dist/integration/tools.js'
import { footerIndicator, kinexFooter } from '../dist/integration/footer.js'

const theme = { fg: (_color, text) => text, bold: text => text }
const context = { expanded: false, args: {}, isError: false }
const plain = component => component.render(100).map(stripTerminalSequences).join('\n').trim()
initTheme('dark', false)

test('important tools show action and target, including streamed arguments and aliases', async () => {
  for (const [name, args, expected] of [
    ['device', { deviceID: 'arm', action: 'write', args: { target: [1, 2] } }, 'device write arm'],
    ['device', { deviceID: 'camera' }, 'device read camera'],
    ['devices', { calls: [{ deviceID: 'arm' }, { deviceID: 'camera' }] }, 'devices 2 calls'],
    ['record', { action: 'start', devices: { arm: 10, camera: 2 } }, 'record start arm=10Hz camera=2Hz'],
    ['record', { action: 'snap', devices: ['arm', 'camera'] }, 'record snap arm, camera'],
    ['device_stop', {}, 'device_stop all'],
    ['servo', { device: 'arm', joints: [1, 2] }, 'servo arm joints'],
    ['exec', { description: 'inspect arm state', python: 'from kinex import device' }, 'exec inspect arm state'],
    ['exec', { description: 'inspect arm state', file: 'scripts/inspect.py' }, 'exec inspect arm state'],
    ['exec', { file: 'scripts/inspect.py' }, 'exec scripts/inspect.py'],
    ['exec', { description: '  ', file: 'scripts/inspect.py' }, 'exec scripts/inspect.py'],
    ['exec', { python: 'from kinex import device\nprint(device("arm"))' }, 'exec python script'],
    ['exec', { description: 'inspect' }, 'exec inspect'],
    ['exec', {}, 'exec python script'],
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

test('exec labels preserve aliases, sanitize text and truncate without hiding expanded source', () => {
  const renderers = toolRenderers('exec', 'kinex_exec')
  const args = { description: '\x1b[2Jinspect\narm state', python: 'from kinex import device\nprint(device("arm"))' }
  assert.equal(plain(renderers.renderCall(args, theme, context)), 'kinex_exec inspect arm state')
  const narrow = renderers.renderCall(args, theme, context).render(20)
  assert.equal(narrow.length, 1)
  assert.ok(visibleWidth(narrow[0]) <= 20)
  const expanded = plain(renderers.renderCall(args, theme, { ...context, expanded: true }))
  assert.match(expanded, /from kinex import device/)
})

test('all Kinex tools share JSON result formatting regardless of argument-summary support', () => {
  const value = { observation: { pose: { position: [1, 2, 3] } } }
  const expected = '{\n  "observation": {\n    "pose": {"position":[1,2,3]}\n  }\n}'
  for (const name of ['devices', 'relative_pose', 'locate_object_3d', 'run_policy', 'workspace_tool']) {
    const result = { content: [{ type: 'text', text: JSON.stringify(value, null, 4) }] }
    assert.equal(plain(toolRenderers(name).renderResult(result, { expanded: true }, theme, context)).split('\n').map(line => line.trimEnd()).join('\n'), expected)
    assert.equal(plain(toolRenderers(name).renderResult({ content: [{ type: 'text', text: 'plain text result' }] }, { expanded: true }, theme, context)), 'plain text result')
  }
})

test('tool expansion reveals arguments and results, while collapsed views bound visual lines', async t => {
  const renderers = toolRenderers('device')
  const args = { action: 'write', deviceID: 'arm', args: { target: [0, 1, 2], duration_s: 1 } }
  const expanded = plain(renderers.renderCall(args, theme, { ...context, expanded: true }))
  assert.match(expanded, /"target": \[0,1,2\]/)
  assert.match(expanded, /"duration_s": 1/)
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
  assert.equal(plain(renderers.renderResult(withImage, { expanded: true }, theme, context)), full)
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
  const footer = kinexFooter({ render: () => lines, invalidate() {} }, () => ({ recording: name }))
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

test('session time shares the stats row and preserves upstream layout and recording', () => {
  const render = width => [truncateToWidth('/workspace', width),
    truncateToWidth('↑1000 ↓20 CH80% $1.00 0.8%/128k (auto)', Math.max(0, width - 12)).padEnd(Math.max(0, width - 12)) + truncateToWidth(' test-model', Math.min(12, width)),
    truncateToWidth('Kinex · 1/1 devices · auto', width)]
  const base = { render, invalidate() {} }
  const footer = kinexFooter(base, () => ({ time: '\x1b[2mtime 1m02s\x1b[22m', recording: 'run' }))
  for (const width of [1, 10, 30, 60, 100]) {
    const lines = footer.render(width)
    assert.equal(lines.length, 3)
    assert.ok(lines.every(line => visibleWidth(line) <= width), `width ${width}`)
    assert.equal(lines[2], render(width)[2])
    if (width === 100) {
      assert.match(stripTerminalSequences(lines[0]), /rec: run$/)
      assert.match(stripTerminalSequences(lines[1]), /^time 1m02s ↑1000 ↓20 CH80% \$1.00 0.8%\/128k \(auto\) +test-model$/)
    }
  }
})

test('footer refresh pauses while waiting and rejects stale recording updates on shutdown', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let renders = 0
  let listener
  const pending = []
  const widgets = []
  let component
  const base = { render: () => ['/workspace', 'model'], invalidate() {} }
  const tui = { children: [{ children: [base] }], requestRender() { renders++ } }
  const runtime = {
    subscribe: callback => { listener = callback; return () => { listener = undefined } },
    recording: { status: () => new Promise(resolve => pending.push(resolve)) },
  }
  const ctx = { hasUI: true, ui: {
    setWidget: (...args) => { widgets.push(args); if (args[1]) assert.deepEqual(args[1](tui).render(100), []) },
    setFooter: factory => { component = factory?.(tui, theme) },
    notify: message => assert.fail(message),
  } }
  const indicator = footerIndicator(() => '0s')
  const binding = indicator.bind(runtime, ctx)
  pending.shift()({ status: 'recording', name: 'test recording' })
  await binding
  assert.equal(widgets.at(-1)[1], undefined)
  assert.match(component.render(40)[0], /\x1b\[31mrec: test recording/)
  assert.equal(component.render(40).length, 2)
  indicator.refresh(true)
  const active = renders
  t.mock.timers.tick(1000)
  assert.equal(renders, active + 1)
  indicator.refresh(false)
  const paused = renders
  t.mock.timers.tick(5000)
  assert.equal(renders, paused)
  listener({ type: 'recording.changed' })
  listener({ type: 'recording.changed' })
  const stale = pending.shift()
  pending.shift()(undefined)
  await Promise.resolve()
  assert.deepEqual(component.render(40), ['/workspace', 'time 0s model'])
  stale({ status: 'recording', name: 'stale' })
  await Promise.resolve()
  assert.deepEqual(component.render(40), ['/workspace', 'time 0s model'])
  listener({ type: 'recording.changed' })
  indicator.refresh(true)
  indicator.clear()
  const stopped = renders
  t.mock.timers.tick(5000)
  assert.equal(renders, stopped)
  pending.shift()({ status: 'recording', name: 'outgoing session' })
  await Promise.resolve()
  assert.equal(component, undefined)
  assert.equal(listener, undefined)
  await indicator.bind(runtime, { hasUI: false })
  assert.equal(pending.length, 0)
})

test('world time display removes float noise without changing tool data or joint precision', () => {
  const value = { time_s: 13793.14999993953, waited_s: .9999999999854481,
    budget: { used_s: 13788.800000000001, max_s: null }, positions: [.3359920570733036] }
  const result = { content: [{ type: 'text', text: JSON.stringify(value) }] }
  const before = structuredClone(result)
  for (const compact of [false, true]) {
    const component = toolRenderers('device').renderResult(result, { expanded: true }, theme,
      { ...context, args: { compact } })
    const displayed = component.render(1000).map(stripTerminalSequences).join('\n').trim()
    assert.deepEqual(JSON.parse(displayed), { ...value, time_s: 13793.15, waited_s: 1,
      budget: { used_s: 13788.8, max_s: null } })
    assert.deepEqual(result, before)
  }
})

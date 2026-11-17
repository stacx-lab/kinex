import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stripTerminalSequences, truncateToWidth, visibleWidth, getCapabilities, setCapabilities } from '@earendil-works/pi-tui'
import { initTheme } from '@earendil-works/pi-coding-agent'
import { commandRow, toolRenderers } from '../dist/integration/render.js'
import { piResult } from '../dist/integration/tools.js'
import { footerIndicator, kinexFooter } from '../dist/integration/footer.js'

const theme = { fg: (_color, text) => text, bold: text => text, italic: text => text }
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
  ]) assert.equal(plain(toolRenderers(name).renderCall(args, theme, context)), expected)
  for (const args of [undefined, null, {}, { devices: { arm: null } }]) {
    assert.doesNotThrow(() => plain(toolRenderers('record').renderCall(args, theme, context)))
  }
  assert.equal(plain(toolRenderers('unknown_custom_tool').renderCall({}, theme, context)), 'unknown_custom_tool')
  for (const [name, args, subject] of [['exec', { program: 'demo.views' }, 'demo.views'], ['exec', { file: 'scripts/inspect.py' }, 'scripts/inspect.py'], ['device', { deviceID: 'arm' }, 'read arm']]) {
    const colors = new Map()
    toolRenderers(name).renderCall(args, { ...theme, fg: (color, text) => { colors.set(text, color); return text } }, context)
    assert.equal(colors.get(subject), 'accent')
  }
})

test('an exec title names the program or file, then its arguments, then the description in italics', () => {
  const styles = []
  const traced = { ...theme, fg: (color, text) => { styles.push([color, text]); return text }, italic: text => `<i>${text}</i>` }
  const title = args => { styles.length = 0; return plain(toolRenderers('exec').renderCall(args, traced, context)) }
  assert.equal(title({ description: 'pick the block', program: 'tabletop.pick_place', args: { object: 'red block', attempts: 2 } }),
    'exec tabletop.pick_place object="red block" attempts=2 <i>pick the block</i>')
  assert.deepEqual(styles.map(([color]) => color), ['toolTitle', 'accent', 'muted', 'muted'])
  assert.equal(title({ description: '  ', file: 'scripts/inspect.py', argv: ['--arm', 'left'], args: { speed: .5 } }), 'exec scripts/inspect.py --arm left speed=0.5')
  assert.equal(title({ description: 'inspect arm state', python: 'print(1)' }).split('\n')[0].trimEnd(), 'exec <i>inspect arm state</i>')
})

test('exec calls show inline source under the title, bounded until expanded', () => {
  const renderers = toolRenderers('exec')
  const call = (args, expanded = false) => renderers.renderCall(args, theme, { ...context, expanded }).render(100).map(line => stripTerminalSequences(line).trimEnd())
  assert.deepEqual(call({ description: 'inspect arm state', python: 'from kinex import runtime\nprint(runtime.devices())' }),
    ['exec inspect arm state', '', 'from kinex import runtime', 'print(runtime.devices())'])
  assert.deepEqual(call({ description: 'pick the block', program: 'tabletop.pick_place', args: { object: 'red block' } }, true),
    ['exec tabletop.pick_place object="red block" pick the block'])
  assert.deepEqual(call({ description: 'inspect' }), ['exec inspect'])
  assert.deepEqual(call({}), ['exec'])
  const source = Array.from({ length: 25 }, (_, i) => `x${i} = ${i}`).join('\n')
  const collapsed = call({ python: source })
  assert.equal(collapsed.length, 13)
  assert.equal(collapsed[11], 'x9 = 9')
  assert.match(collapsed[12], /expand \(15 more lines\)/)
  assert.deepEqual(call({ python: source }, true), ['exec', '', ...source.split('\n')])
  const eleven = source.split('\n').slice(0, 11).join('\n')
  assert.deepEqual(call({ python: eleven }), ['exec', '', ...eleven.split('\n')])
})

test('exec labels and scripts sanitize text and truncate the title', () => {
  const renderers = toolRenderers('exec')
  const args = { description: '\x1b[2Jinspect\narm state', python: 'print("\x1b[2Jhi")' }
  const narrow = renderers.renderCall(args, theme, context).render(20)
  assert.ok(visibleWidth(narrow[0]) <= 20)
  assert.match(stripTerminalSequences(narrow[0]), /^exec inspect arm/)
  assert.ok(!narrow.some(line => line.includes('\x1b[2J')))
  const result = { content: [{ type: 'text', text: JSON.stringify({ output: '\x1b[2Jprinted', result: null }) }] }
  const shown = renderers.renderResult(result, { expanded: true }, theme, context).render(100)
  assert.ok(!shown.some(line => line.includes('\x1b[2J')))
  assert.equal(plain(renderers.renderResult(result, { expanded: true }, theme, context)), 'printed')
})

test('exec results show printed output, then the result or the failure once, as plain lines', () => {
  const renderers = toolRenderers('exec')
  const show = (envelope, { expanded = true, isError = false } = {}) => renderers.renderResult(
    { content: [{ type: 'text', text: typeof envelope === 'string' ? envelope : JSON.stringify(envelope, null, 2) }] },
    { expanded }, theme, { ...context, isError }).render(100).map(line => stripTerminalSequences(line).trimEnd())
  assert.deepEqual(show({ output: 'loaded\nready\n', result: { position: [.5, -1], pose: { z: .4 }, time_s: 1.0000000001 } }),
    ['', 'loaded', 'ready', '', '{', '  "position": [0.5,-1],', '  "pose": {"z":0.4},', '  "time_s": 1', '}'])
  assert.deepEqual(show({ output: '', result: [1, 2] }), ['', '[1,2]'])
  assert.deepEqual(show({ output: '', result: 'done\nok' }), ['', 'done', 'ok'])
  assert.deepEqual(show({ output: '', result: null }), [])
  const traceback = 'Traceback (most recent call last):\n  File "<exec>", line 1\nRuntimeError: boom'
  assert.deepEqual(show({ output: 'hi\n', error: traceback }, { isError: true }), ['', 'hi', '', ...traceback.split('\n')])
  assert.deepEqual(show({ output: '', error: 'wait failed', code: 'OperationError', details: 'sequential' }, { isError: true }),
    ['', 'wait failed', '{', '  "code": "OperationError",', '  "details": "sequential"', '}'])
  assert.deepEqual(show('The user rejected permission "python_tool".', { isError: true }), ['', 'The user rejected permission "python_tool".'])
  const printed = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')
  const collapsed = show({ output: printed, error: traceback }, { expanded: false, isError: true })
  assert.equal(collapsed[0], '')
  assert.match(collapsed[1], /expand \(18 more lines\)/)
  assert.deepEqual(collapsed.slice(2), ['line 18', 'line 19', '', ...traceback.split('\n')])
})

test('exec results set apart the exception, a subagent\'s line and a long run\'s duration', () => {
  const colors = []
  const traced = { ...theme, fg: (color, text) => { colors.push([color, text]); return text } }
  const show = (envelope, extra = {}, expanded = true) => toolRenderers('exec').renderResult({ content: [{ type: 'text', text: JSON.stringify(envelope) }] },
    { expanded }, traced, { ...context, ...extra }).render(100).map(line => stripTerminalSequences(line).trimEnd())
  show({ output: '', error: 'Traceback (most recent call last):\n  File "<exec>", line 1\nRuntimeError: boom' }, { isError: true })
  assert.deepEqual(colors, [['muted', 'Traceback (most recent call last):'], ['muted', '  File "<exec>", line 1'], ['error', 'RuntimeError: boom']])
  colors.length = 0
  show({ output: 'subagent fake/test (1.2 s): centred\nsubagent failed: no reply\nplain\n', result: null })
  assert.deepEqual(colors, [['accent', 'subagent fake/test (1.2 s):'], ['toolOutput', ' centred'], ['error', 'subagent failed: no reply'], ['toolOutput', 'plain']])
  assert.deepEqual(show({ output: '', result: 1 }, { durationMs: 1650 }), ['', '1', '', 'took 1.6 s'])
  assert.deepEqual(show({ output: '', result: 1 }, { durationMs: 900 }), ['', '1'])
  assert.deepEqual(show({ output: '', result: null }, { durationMs: 2000 }), ['', 'took 2.0 s'])
  // Collapsed rows shorten floats for reading; expanded rows and the model keep every digit.
  const value = { pose: [0.123456789012, -1.5, 2], stamp: 1794868502.4852428, tiny: 2.853e-12 }
  assert.deepEqual(show({ output: '', result: value }, {}, false), ['', '{', '  "pose": [0.123457,-1.5,2],', '  "stamp": 1794868502.485,', '  "tiny": 2.853e-12', '}'])
  assert.deepEqual(show({ output: '', result: value }), ['', '{', '  "pose": [0.123456789012,-1.5,2],', '  "stamp": 1794868502.4852428,', '  "tiny": 2.853e-12', '}'])
})

test('JSON is highlighted as code in results and expanded arguments, and failures stay in the error colour', () => {
  const sequences = text => new Set(text.match(/\x1b\[[0-9;]*m/g) ?? [])
  const result = { content: [{ type: 'text', text: JSON.stringify({ name: 'arm', position: [1, 2], ready: true }) }] }
  for (const name of ['device', 'lib', 'question', 'workspace_tool']) {
    const raw = toolRenderers(name).renderResult(result, { expanded: true }, theme, context).render(100).join('\n')
    assert.ok(sequences(raw).size > 2, `${name} result`)
    assert.deepEqual(JSON.parse(stripTerminalSequences(raw)), { name: 'arm', position: [1, 2], ready: true })
  }
  const exec = toolRenderers('exec').renderResult({ content: [{ type: 'text', text: JSON.stringify({ output: '', result: { name: 'arm', ready: true } }) }] }, { expanded: true }, theme, context)
  assert.ok(sequences(exec.render(100).join('\n')).size > 2)
  assert.ok(sequences(toolRenderers('device').renderCall({ deviceID: 'arm', args: { target: [1, 2] } }, theme, { ...context, expanded: true }).render(100).join('\n')).size > 2)
  const colors = []
  toolRenderers('device').renderResult(result, { expanded: true }, { ...theme, fg: (color, text) => { colors.push(color); return text } }, { ...context, isError: true })
  assert.deepEqual(colors, ['error'])
  assert.equal(plain(toolRenderers('question').renderCall({ questions: [{ header: 'Which bowl?' }, { header: 'Grip' }] }, theme, context)), 'question Which bowl?, Grip')
})

test('a user command is drawn as a tool row: pending while it runs, then its outcome', () => {
  const backgrounds = []
  const colors = new Map()
  const traced = { ...theme, bg: (color, text) => { backgrounds.push(color); return text }, fg: (color, text) => { colors.set(text, color); return text } }
  const lines = (row, options = {}) => commandRow(row, traced, { expanded: false, outputPad: 1, ...options }).render(60).map(line => stripTerminalSequences(line).trimEnd())
  const status = { render: () => ['', 'running'], invalidate() {} }
  assert.deepEqual(lines({ name: 'exec', args: 'demo.views object="black bowl"' }, { status }), ['', ' exec demo.views object="black bowl"', '', ' running', ''])
  assert.deepEqual([...new Set(backgrounds)], ['toolPendingBg'])
  assert.deepEqual([colors.get('demo.views'), colors.get('object="black bowl"')], ['accent', 'muted'])
  backgrounds.length = 0
  const done = lines({ name: 'exec', args: 'demo.views', result: { text: JSON.stringify({ output: '', result: { ok: true } }), isError: false, durationMs: 4600 } })
  assert.deepEqual(done, ['', ' exec demo.views', '', ' {', '   "ok": true', ' }', '', ' took 4.6 s', ''])
  assert.ok(!done.join('\n').includes('User ran'))
  assert.deepEqual([...new Set(backgrounds)], ['toolSuccessBg'])
  backgrounds.length = 0
  assert.deepEqual(lines({ name: 'load', args: 'arm', result: { text: 'arm: Error: no node', isError: true } }), ['', ' load arm', '', ' arm: Error: no node', ''])
  assert.deepEqual([...new Set(backgrounds)], ['toolErrorBg'])
  assert.deepEqual(lines({ name: 'devices', args: '', result: { text: 'arm: joint, loaded', isError: false } }), ['', ' devices', '', ' arm: joint, loaded', ''])
  const long = { name: 'lib', args: '', result: { text: JSON.stringify({ node: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, i])) }), isError: false } }
  assert.match(lines(long).join('\n'), /expand \(\d+ more lines\)/)
  assert.match(lines(long, { expanded: true }).join('\n'), /"k19": 19/)
})

test('a user command row shows the images its program returned where the terminal can', t => {
  const capabilities = getCapabilities()
  t.after(() => setCapabilities(capabilities))
  const row = { name: 'exec', args: 'demo.views', result: { text: JSON.stringify({ output: '', result: null }), isError: false, images: [{ mimeType: 'image/png', data: 'aW1hZ2U=' }] } }
  const height = () => commandRow(row, { ...theme, bg: (_color, text) => text }, { expanded: false, outputPad: 1 }).render(60).length
  setCapabilities({ ...capabilities, images: null })
  const without = height()
  setCapabilities({ ...capabilities, images: 'kitty' })
  assert.ok(height() > without)
})

test('all Kinex tools share JSON result formatting regardless of argument-summary support', () => {
  const value = { observation: { pose: { position: [1, 2, 3] } } }
  const expected = '{\n  "observation": {\n    "pose": {"position":[1,2,3]}\n  }\n}'
  for (const name of ['devices', 'lib', 'workspace_tool']) {
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
  assert.equal(preview.length, 6)
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

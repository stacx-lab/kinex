import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, SessionManager } from '@earendil-works/pi-coding-agent'
import { parseKinexArgs, isPrintMode } from '../dist/arguments.js'
import { rewriteResumeHint, installResumeHint } from '../dist/resume-hint.js'
import { resolveSession, listKinexSessions } from '../dist/sessions.js'
import { sessionDirectory } from '../dist/settings.js'
import { isolate, fakeProvider, workspace } from './helpers.mjs'

const exec = promisify(execFile)
const entry = fileURLToPath(new URL('../bin/kinex.mjs', import.meta.url))
const isolation = await isolate()
after(isolation.cleanup)

function invoke(cwd, args, input = '') {
  const pending = exec(process.execPath, [entry, ...args], { cwd, env: process.env, timeout: 20000 })
  pending.child.stdin.end(input)
  return pending
}

test('common arguments retain Pi parsing, including aliases, multiple prompts and --', () => {
  for (const args of [
    ['-p', 'first', 'second'], ['--print', '--', '-not-an-option'], ['-c', 'next'], ['-r'],
    ['--mode', 'json', 'prompt'], ['--provider', 'fake', '--model', 'test:high', '--thinking', 'max'],
    ['--session', 'id'], ['--', 'run'], ['--help'], ['-v'],
  ]) assert.deepEqual(parseKinexArgs(args).pi, parseArgs(args))
  const parsed = parseKinexArgs(['--auto', '-p', '--record=arm=10', '--enable-recording', 'prompt'])
  assert.equal(parsed.mode, 'auto')
  assert.equal(parsed.record, 'arm=10')
  assert.equal(parsed.enableRecording, true)
  assert.deepEqual(parsed.pi.messages, ['prompt'])
  assert.deepEqual(parseKinexArgs(['-p', '--', '--auto', '--record']).pi.messages, ['--auto', '--record'])
  assert.equal(parseKinexArgs(['--model', 'auto', 'prompt']).pi.model, 'auto')
  assert.equal(isPrintMode(parseArgs([]), true, true), false)
  for (const [args, stdin, stdout] of [[['-p'], true, true], [['--mode', 'json'], true, true], [[], false, true], [[], true, false]]) {
    assert.equal(isPrintMode(parseArgs(args), stdin, stdout), true)
  }
})

test('run aliases print while preserving options and literal prompts after --', () => {
  for (const args of [[], ['first', 'second'], ['--mode', 'json', 'prompt'], ['--auto', '--record', 'arm=10', 'prompt'], ['--', '-literal']]) {
    assert.deepEqual(parseKinexArgs(['run', ...args]), parseKinexArgs(['-p', ...args]))
  }
  assert.equal(isPrintMode(parseKinexArgs(['run', 'prompt']).pi, true, true), true)
  assert.deepEqual(parseKinexArgs(['--', 'run']).pi.messages, ['run'])
  assert.throws(() => parseKinexArgs(['run', '--unknown']), /Unsupported option/)
})

test('unsupported, retired and malformed arguments fail before application construction', () => {
  for (const args of [
    ['--seed', 'x'], ['--json'], ['--effort', 'high'], ['--mode', 'rpc'], ['--no-tools'],
    ['--session-dir', 'somewhere'], ['@image.png'], ['--unknown'], ['-z'],
    ['--model'], ['--model', '--auto'], ['--record'], ['--record='], ['--provider', 'fake'],
    ['--auto', '--yolo'], ['--mode', 'wrong'],
  ]) assert.throws(() => parseKinexArgs(args), Error, args.join(' '))
})

test('print, multiple prompts, piped text and JSON use Pi execution with a fake provider', async t => {
  const cwd = await workspace(t)
  const fake = await fakeProvider(t, isolation.root)
  assert.match((await invoke(cwd, ['-p', '--provider', 'fake', '--model', 'test', 'first', 'second'])).stdout, /FAKE_REPLY_OK/)
  assert.equal(fake.requests.length, 2)
  assert.match(JSON.stringify(fake.requests[1].messages), /first/)
  assert.match(JSON.stringify(fake.requests[1].messages), /second/)
  const result = await invoke(cwd, ['--mode', 'json', '--model', 'fake/test', ' plus prompt'], 'piped text\n')
  const events = result.stdout.trim().split('\n').map(line => JSON.parse(line))
  assert.ok(events.some(event => event.type === 'session'))
  assert.match(JSON.stringify(fake.requests.at(-1).messages), /piped text plus prompt/)
  await invoke(cwd, [], 'stdin-only prompt')
  assert.match(JSON.stringify(fake.requests.at(-1).messages), /stdin-only prompt/)
  await invoke(cwd, ['--print', '--', '-literal prompt'])
  assert.match(JSON.stringify(fake.requests.at(-1).messages), /-literal prompt/)
})

test('run executes prompts, JSON output and direct robotics commands', async t => {
  const cwd = await workspace(t)
  const fake = await fakeProvider(t, isolation.root)
  assert.match((await invoke(cwd, ['run', 'first', 'second'])).stdout, /FAKE_REPLY_OK/)
  assert.equal(fake.requests.length, 2)
  const result = await invoke(cwd, ['run', '--mode', 'json', ' plus prompt'], 'piped text\n')
  const events = result.stdout.trim().split('\n').map(line => JSON.parse(line))
  assert.ok(events.some(event => event.type === 'session'))
  assert.match(JSON.stringify(fake.requests.at(-1).messages), /piped text plus prompt/)
  assert.match((await invoke(cwd, ['run', '/devices'])).stdout, /No devices/)
  assert.equal(fake.requests.length, 3)
})

test('continue and partial session IDs reopen the saved conversation', async t => {
  const cwd = await workspace(t)
  const fake = await fakeProvider(t, isolation.root)
  await invoke(cwd, ['-p', 'remember CLI_HISTORY_MARKER'])
  const [first] = await SessionManager.list(cwd, sessionDirectory(cwd))
  for (const args of [['-c'], ['--continue'], ['--session', first.id.slice(0, 8)], ['--session', first.path]]) {
    await invoke(cwd, [...args, '-p', 'what do you remember?'])
    assert.match(JSON.stringify(fake.requests.at(-1).messages), /CLI_HISTORY_MARKER/)
  }
  const sessions = await SessionManager.list(cwd, sessionDirectory(cwd))
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].id, first.id)
})

test('session lookup rejects ambiguous prefixes and preserves all-workspace discovery', async t => {
  const cwd = await workspace(t), other = await workspace(t)
  for (const [directory, id] of [[cwd, 'abc-first'], [cwd, 'abc-second'], [other, 'elsewhere']]) {
    const folder = sessionDirectory(directory)
    await mkdir(folder, { recursive: true })
    await writeFile(path.join(folder, `${id}.jsonl`), JSON.stringify({ type: 'session', version: 3, id, cwd: directory, timestamp: new Date().toISOString() }) + '\n')
  }
  await assert.rejects(resolveSession('abc', cwd), /Ambiguous/)
  await assert.rejects(resolveSession('missing', cwd), /Unknown/)
  assert.equal(await resolveSession('abc-first', cwd), path.join(sessionDirectory(cwd), 'abc-first.jsonl'))
  assert.equal(await resolveSession('else', cwd), path.join(sessionDirectory(other), 'elsewhere.jsonl'))
  assert.ok((await listKinexSessions()).some(session => session.id === 'elsewhere'))
})

test('model resolution uses Pi matching and explicit thinking overrides the suffix', async t => {
  const cwd = await workspace(t)
  const fake = await fakeProvider(t, isolation.root)
  const config = path.join(isolation.root, 'config/agent/models.json')
  const models = JSON.parse(await readFile(config, 'utf8'))
  models.providers.fake.models[0].reasoning = true
  await writeFile(config, JSON.stringify(models))
  const { createApplication } = await import('../dist/application.js')
  for (const options of [
    { provider: 'fake', model: 'tes:high' },
    { model: 'fake/tes:low', thinkingLevel: 'high' },
  ]) {
    const app = await createApplication({ cwd, ...options })
    try {
      assert.equal(app.host.session.model.id, 'test')
      assert.equal(app.host.session.thinkingLevel, 'high')
    } finally { await app.dispose() }
  }
  assert.equal(fake.requests.length, 0)
  await assert.rejects(createApplication({ cwd, model: 'no-such-model' }), /model/i)
})

test('help, direct commands and invalid resume need no provider or session', async t => {
  const cwd = await workspace(t)
  assert.match((await invoke(cwd, ['--help'])).stdout, /--resume, -r/)
  await assert.rejects(invoke(cwd, ['-r']), error => /requires a terminal/.test(error.stderr))
  await assert.rejects(invoke(cwd, ['--seed', 'old syntax']), error => /was removed/.test(error.stderr))
  await assert.rejects(stat(sessionDirectory(cwd)), { code: 'ENOENT' })
  assert.match((await invoke(cwd, ['-p', '/devices'])).stdout, /No devices/)
  await assert.rejects(stat(path.join(cwd, '.kinex')), { code: 'ENOENT' })
})

test('resume output adapter changes only the exact current-session hint', async t => {
  const cwd = await workspace(t)
  const file = path.join(cwd, "session with 'quotes'.jsonl")
  await writeFile(file, '{}')
  let id = 'first'
  const manager = { getSessionId: () => id, getSessionFile: () => file, isPersisted: () => true }
  const hint = value => `\x1b[2mTo resume this session:\x1b[22m pi --session-dir '/with spaces' --session ${value}\n`
  const changed = rewriteResumeHint(hint(id), manager)
  assert.match(changed, /kinex --session/)
  assert.doesNotMatch(changed, /--session-dir/)
  assert.equal((await exec('bash', ['-c', `kinex() { printf '%s' "$2"; }; ${changed.replace(/\x1b\[[0-9;]*m/g, '').split(': ')[1]}`])).stdout, file)
  for (const text of ['pi --session first', 'model mentioned pi', 'To resume this session: pi --session other\n', `reply\n${hint(id)}`, hint(id) + 'more']) {
    assert.equal(rewriteResumeHint(text, manager), text)
  }
  const output = [], original = process.stdout.write
  process.stdout.write = (chunk, ...rest) => { output.push(chunk); const callback = rest.find(value => typeof value === 'function'); callback?.(); return false }
  const restore = installResumeHint(() => manager)
  let callbackCalled = false
  let thirdCallbackCalled = false
  try {
    assert.equal(process.stdout.write(Buffer.from('unrelated')), false)
    process.stdout.write('normal output', () => { callbackCalled = true })
    id = 'second'
    process.stdout.write(hint(id), 'utf8')
    process.stdout.write('third callback', undefined, () => { thirdCallbackCalled = true })
  } finally { restore(); process.stdout.write = original }
  assert.deepEqual(output[0], Buffer.from('unrelated'))
  assert.equal(output[1], 'normal output')
  assert.match(output[2], /kinex --session/)
  assert.equal(callbackCalled, true)
  assert.equal(thirdCallbackCalled, true)
  assert.equal((await readdir(cwd)).length, 1)
})

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
// Core reads the configuration folder when it loads, so the layout comes first.
const root = await mkdtemp(path.join(tmpdir(), 'kinex-sandbox-'))
process.env.KINEX_CONFIG_DIR = path.join(root, 'config')
process.env.KINEX_DATA_DIR = path.join(root, 'data')
const { sandboxed, sandboxOf } = await import('../dist/sandbox.js')
const { pythonDir } = await import('../dist/layout.js')

const put = async (file, text) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text) }
const run = path.join(root, 'data/self-improve/20260101-000000')
const workspace = path.join(run, 'trials/t001/workspace')
const session = path.join(run, 'trials/t001/record/session.jsonl')
const agent = path.join(root, 'config/agent')
await put(path.join(workspace, '.kinex/kinex.json'), '{}')
await put(session, '')
await put(path.join(run, 'trials/t002/record/result.json'), '{"success":true}')
await put(path.join(run, 'libraries/L1/manifest.json'), '{}')
await put(path.join(agent, 'settings.json'), '{}')
await put(path.join(root, 'data/agent/auth.json'), '{}')
await mkdir(pythonDir(), { recursive: true })
await symlink(path.join(root, 'data/agent/auth.json'), path.join(agent, 'auth.json'))
after(() => rm(root, { recursive: true, force: true }))
await put(path.join(agent, 'agents/self-improve-trial.md'), 'the command a trial is started with')
// Awaited before the first test: a test file whose tests have all ended runs its after hooks.
// A sandbox can run here when a worker could start in it, which Docker cannot where it may not read Node's folder.
const can = Object.fromEntries(await Promise.all(['bwrap', 'docker'].map(async kind => [kind, await sandboxOf(kind).then(() => true, () => false)])))

const binds = (argv, flag) => argv.flatMap((arg, index) => arg === flag ? [argv[index + 1]] : [])

test('a worker can write only its workspace, its transcript and its credentials', () => {
  const argv = sandboxed(['node', 'kinex', 'run'], workspace, session)
  assert.equal(argv[0], 'bwrap')
  assert.deepEqual(argv.slice(argv.indexOf('--') + 1), ['node', 'kinex', 'run'])
  assert.deepEqual(binds(argv, '--bind'), [agent, path.join(root, 'data/agent/auth.json'), workspace, session])
  const readOnly = binds(argv, '--ro-bind')
  assert.ok(!readOnly.includes('/'), 'the sandbox starts from an empty root')
  for (const kept of [path.join(agent, 'settings.json'), path.join(agent, 'agents')]) {
    assert.ok(readOnly.includes(kept), `${kept} stays read-only inside the writable agent folder`)
    assert.ok(argv.indexOf(kept) > argv.indexOf(agent), 'bound over the agent folder')
  }
  for (const hidden of [run, path.join(root, 'data'), path.join(root, 'data/self-improve')])
    assert.ok(![...readOnly, ...binds(argv, '--bind')].includes(hidden), `${hidden} is not bound`)
})

test('a Docker sandbox is given the same folders, and the worker\'s environment by name', () => {
  const argv = sandboxed(['node', 'kinex', 'run'], workspace, session, 'docker', { name: 'worker-t001', env: { KINEX_SELF_IMPROVE_ROLE: 'worker', 'not a name': 'x' } })
  assert.deepEqual(argv.slice(0, 5), ['docker', 'run', '--rm', '--name', 'worker-t001'])
  assert.deepEqual(argv.slice(-4), ['ubuntu:24.04', 'node', 'kinex', 'run'])
  const mounts = binds(argv, '--mount').map(mount => mount.replace(/^type=bind,source=([^,]+),target=\1/, '$1'))
  assert.deepEqual(mounts.filter(mount => !mount.endsWith(',readonly')), [agent, path.join(root, 'data/agent/auth.json'), workspace, session])
  for (const kept of ['/usr', '/etc', path.join(agent, 'settings.json'), path.join(agent, 'agents')]) assert.ok(mounts.includes(`${kept},readonly`), kept)
  for (const hidden of [run, path.join(root, 'data'), path.join(root, 'data/self-improve')]) assert.ok(!mounts.some(mount => mount.split(',')[0] === hidden), `${hidden} is not bound`)
  assert.deepEqual(binds(argv, '--env'), ['KINEX_SELF_IMPROVE_ROLE', 'FASTDDS_BUILTIN_TRANSPORTS=UDPv4'])
  assert.deepEqual([binds(argv, '--network'), binds(argv, '--cap-drop'), binds(argv, '--workdir')], [['host'], ['ALL'], [workspace]])
})

for (const kind of ['bwrap', 'docker']) test(`inside the ${kind} sandbox, other trials, libraries and host processes have no name`, { skip: !can[kind] && `${kind} cannot run a worker here` }, async () => {
  const probe = `
    const fs = require('node:fs')
    const seen = file => fs.existsSync(file)
    fs.writeFileSync('kept.txt', 'kept')
    fs.appendFileSync(${JSON.stringify(session)}, '{"line":1}\\n')
    const write = file => { try { fs.writeFileSync(file, 'changed'); return 'writable' } catch (error) { return error.code } }
    const settings = write(${JSON.stringify(path.join(agent, 'settings.json'))})
    const agents = write(${JSON.stringify(path.join(agent, 'agents/self-improve-trial.md'))})
    console.log(JSON.stringify({
      otherTrial: seen(${JSON.stringify(path.join(run, 'trials/t002/record/result.json'))}),
      library: seen(${JSON.stringify(path.join(run, 'libraries/L1/manifest.json'))}),
      parent: seen('/proc/${process.pid}'),
      processes: fs.readdirSync('/proc').filter(name => /^\\d+$/.test(name)).length,
      settings, agents,
    }))`
  await writeFile(session, '')
  const [file, ...args] = sandboxed([process.execPath, '-e', probe], workspace, session, kind)
  const { stdout } = await exec(file, args)
  const seen = JSON.parse(stdout.trim().split('\n').at(-1))
  assert.deepEqual({ ...seen, processes: seen.processes <= 3 }, { otherTrial: false, library: false, parent: false, processes: true, settings: 'EROFS', agents: 'EROFS' })
  assert.equal(await readFile(path.join(workspace, 'kept.txt'), 'utf8'), 'kept')
  assert.equal(await readFile(session, 'utf8'), '{"line":1}\n')
  assert.ok(existsSync(path.join(run, 'trials/t002/record/result.json')))
})

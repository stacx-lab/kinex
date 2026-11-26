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
const { sandboxed, unavailable } = await import('../dist/sandbox.js')
const { homeOf, pythonDir } = await import('../dist/layout.js')
const { trialPython } = await import('../dist/trial.js')
const { childEnv } = await import('../dist/session.js')

const put = async (file, text) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text) }
// A run belongs to the workspace it was planned in, which has content of its own that no child may find.
const home = path.join(root, 'robot')
const run = path.join(home, '.kinex/self-improve/runs/20260101-000000')
const python = pythonDir(homeOf(run))
const workspace = path.join(run, 'trials/t001/workspace')
const session = path.join(run, 'trials/t001/record/session.jsonl')
const agent = path.join(root, 'config/agent')
const own = { skill: path.join(home, '.kinex/skills/mine/SKILL.md'), settings: path.join(home, '.kinex/kinex.json'), instructions: path.join(home, 'AGENTS.md') }
await put(own.skill, '---\nname: mine\ndescription: the workspace\'s own\n---\n')
await put(own.settings, '{"python":{"provider":"ros-humble","interfaces":["msgs"]}}')
await put(own.instructions, 'the workspace\'s own instructions')
await put(path.join(root, 'config/kinex.json'), '{"python":{"provider":"uv"}}')
await put(path.join(workspace, '.kinex/kinex.json'), '{}')
await put(session, '')
await put(path.join(run, 'trials/t002/record/result.json'), '{"success":true}')
await put(path.join(run, 'libraries/L1/manifest.json'), '{}')
await put(path.join(agent, 'settings.json'), '{}')
await put(path.join(root, 'data/agent/auth.json'), '{}')
await mkdir(python, { recursive: true })
await symlink(path.join(root, 'data/agent/auth.json'), path.join(agent, 'auth.json'))
after(() => rm(root, { recursive: true, force: true }))
await put(path.join(agent, 'agents/self-improve-trial.md'), 'the command a trial is started with')
// Awaited before the first test: a test file whose tests have all ended runs its after hooks.
// A sandbox can run here when a child could start in it, which Docker cannot where it may not read Node's folder.
const can = Object.fromEntries(await Promise.all(['bwrap', 'docker'].map(async kind => [kind, !await unavailable(kind, { python })])))

const binds = (argv, flag) => argv.flatMap((arg, index) => arg === flag ? [argv[index + 1]] : [])
const hidden = [run, home, path.join(home, '.kinex'), path.join(home, '.kinex/self-improve'), path.join(root, 'data')]

test('a child can write only its workspace, what it is given to write and its credentials, and reads the workspace\'s Python', () => {
  const argv = sandboxed(['node', 'kinex', 'run'], workspace, [session], 'bwrap', { python })
  assert.equal(argv[0], 'bwrap')
  assert.deepEqual(argv.slice(argv.indexOf('--') + 1), ['node', 'kinex', 'run'])
  assert.deepEqual(binds(argv, '--bind'), [agent, path.join(root, 'data/agent/auth.json'), workspace, session])
  const readOnly = binds(argv, '--ro-bind')
  assert.ok(!readOnly.includes('/'), 'the sandbox starts from an empty root')
  assert.ok(readOnly.includes(python), 'the trials\' Python is read-only')
  for (const kept of [path.join(agent, 'settings.json'), path.join(agent, 'agents')]) {
    assert.ok(readOnly.includes(kept), `${kept} stays read-only inside the writable agent folder`)
    assert.ok(argv.indexOf(kept) > argv.indexOf(agent), 'bound over the agent folder')
  }
  for (const folder of hidden) assert.ok(![...readOnly, ...binds(argv, '--bind')].includes(folder), `${folder} is not bound`)
})

test('a Docker sandbox is given the same folders, and the child\'s environment by name', () => {
  const argv = sandboxed(['node', 'kinex', 'run'], workspace, [session], 'docker', { name: 'worker-t001', python, env: { KINEX_SELF_IMPROVE_ROLE: 'worker', 'not a name': 'x' } })
  assert.deepEqual(argv.slice(0, 5), ['docker', 'run', '--rm', '--name', 'worker-t001'])
  assert.deepEqual(argv.slice(-4), ['ubuntu:24.04', 'node', 'kinex', 'run'])
  const mounts = binds(argv, '--mount').map(mount => mount.replace(/^type=bind,source=([^,]+),target=\1/, '$1'))
  assert.deepEqual(mounts.filter(mount => !mount.endsWith(',readonly')), [agent, path.join(root, 'data/agent/auth.json'), workspace, session])
  for (const kept of ['/usr', '/etc', python, path.join(agent, 'settings.json'), path.join(agent, 'agents')]) assert.ok(mounts.includes(`${kept},readonly`), kept)
  for (const folder of hidden) assert.ok(!mounts.some(mount => mount.split(',')[0] === folder), `${folder} is not bound`)
  assert.deepEqual(binds(argv, '--env'), ['KINEX_SELF_IMPROVE_ROLE', 'FASTDDS_BUILTIN_TRANSPORTS=UDPv4'])
  assert.deepEqual([binds(argv, '--network'), binds(argv, '--cap-drop'), binds(argv, '--workdir')], [['host'], ['ALL'], [workspace]])
})

test('a child keeps its ROS logs in its sandbox\'s own home, not in the host folders this process names', () => {
  const host = { ROS_HOME: process.env.ROS_HOME, ROS_LOG_DIR: process.env.ROS_LOG_DIR, ROS_DOMAIN_ID: process.env.ROS_DOMAIN_ID }
  Object.assign(process.env, { ROS_HOME: path.join(root, 'ros'), ROS_LOG_DIR: path.join(root, 'ros/log'), ROS_DOMAIN_ID: '7' })
  try {
    for (const role of ['worker', 'distiller']) {
      const env = childEnv(role)
      assert.deepEqual([env.ROS_HOME, env.ROS_LOG_DIR, env.ROS_DOMAIN_ID], [undefined, undefined, '7'], role)
      assert.ok(!binds(sandboxed(['true'], workspace, [session], 'docker', { python, env }), '--env').some(name => name.startsWith('ROS_HOME') || name.startsWith('ROS_LOG_DIR')))
    }
  } finally {
    for (const [name, value] of Object.entries(host)) if (value === undefined) delete process.env[name]; else process.env[name] = value
  }
})

test('a trial\'s Python is prepared from the settings its worker reads in the sandbox, not from the workspace the run belongs to', async () => {
  assert.deepEqual(await trialPython(workspace), { provider: 'uv', interfaces: [] })
  await put(path.join(workspace, '.kinex/kinex.json'), '{"python":{"provider":"ros-jazzy"}}')
  assert.deepEqual(await trialPython(workspace), { provider: 'ros-jazzy', interfaces: [] })
  await put(path.join(workspace, '.kinex/kinex.json'), '{}')
})

for (const kind of ['bwrap', 'docker']) test(`inside the ${kind} sandbox, the workspace the run belongs to, other trials, libraries and host processes have no name`, { skip: !can[kind] && `${kind} cannot run a child here` }, async () => {
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
      ownSkill: seen(${JSON.stringify(own.skill)}), ownSettings: seen(${JSON.stringify(own.settings)}), ownInstructions: seen(${JSON.stringify(own.instructions)}),
      python: seen(${JSON.stringify(python)}),
      parent: seen('/proc/${process.pid}'),
      processes: fs.readdirSync('/proc').filter(name => /^\\d+$/.test(name)).length,
      settings, agents,
    }))`
  await writeFile(session, '')
  const [file, ...args] = sandboxed([process.execPath, '-e', probe], workspace, [session], kind, { python })
  const { stdout } = await exec(file, args)
  const seen = JSON.parse(stdout.trim().split('\n').at(-1))
  assert.deepEqual({ ...seen, processes: seen.processes <= 3 }, { otherTrial: false, library: false, ownSkill: false, ownSettings: false, ownInstructions: false,
    python: true, parent: false, processes: true, settings: 'EROFS', agents: 'EROFS' })
  assert.equal(await readFile(path.join(workspace, 'kept.txt'), 'utf8'), 'kept')
  assert.equal(await readFile(session, 'utf8'), '{"line":1}\n')
  assert.ok(existsSync(path.join(run, 'trials/t002/record/result.json')))
})

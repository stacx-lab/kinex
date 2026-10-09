import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const exec = promisify(execFile)
const entry = fileURLToPath(new URL('../bin/kinex.mjs', import.meta.url))

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'kinex-packages-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cwd = path.join(root, 'workspace'), agent = path.join(root, 'config/agent')
  await mkdir(cwd)
  const env = { ...process.env, KINEX_CONFIG_DIR: path.join(root, 'config'), KINEX_DATA_DIR: path.join(root, 'data'),
    npm_config_audit: 'false', npm_config_fund: 'false', PI_OFFLINE: '0' }
  const invoke = (...args) => exec(process.execPath, [entry, ...args], { cwd, env, timeout: 30000 })
  const configure = async value => {
    await mkdir(agent, { recursive: true })
    await writeFile(path.join(agent, 'settings.json'), JSON.stringify(value))
  }
  return { root, cwd, agent, env, invoke, configure }
}

test('package CLI validates arguments and lists bundled defaults without initializing a workspace', async t => {
  const { root, cwd, invoke } = await fixture(t)
  assert.match((await invoke('list')).stdout, /bundled\s+pi-web-search@1\.7\.0\s+fallback active/)
  for (const args of [['install'], ['remove'], ['update', 'one', 'two'], ['list', '--local'], ['upgrade', '--model', 'x']]) {
    await assert.rejects(invoke(...args), error => error.code === 1)
  }
  assert.match((await invoke('install', '--help')).stdout, /npm:package/)
  for (const file of [path.join(cwd, '.kinex'), path.join(cwd, '.pi'), path.join(root, 'data'), path.join(root, 'config')]) {
    await assert.rejects(stat(file), { code: 'ENOENT' })
  }
})

test('local package install, list and remove preserve scopes, filters and unrelated settings without loading code', async t => {
  const { root, cwd, agent, invoke, configure } = await fixture(t)
  const pkg = path.join(cwd, 'package with spaces')
  await mkdir(pkg)
  await writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: 'local-fixture', pi: { extensions: ['./index.ts'] } }))
  await writeFile(path.join(pkg, 'index.ts'), 'throw new Error("PACKAGE_CODE_MUST_NOT_RUN")')
  await configure({ theme: 'dark', packages: [{ source: pkg, skills: [], prompts: [] }] })
  await invoke('install', './package with spaces')
  let global = JSON.parse(await readFile(path.join(agent, 'settings.json'), 'utf8'))
  assert.equal(global.theme, 'dark')
  assert.equal(global.packages.length, 1)
  assert.deepEqual(global.packages[0].skills, [])
  await invoke('install', './package with spaces', '-l')
  const project = path.join(cwd, '.kinex/agent/settings.json')
  assert.equal(JSON.parse(await readFile(project, 'utf8')).packages.length, 1)
  assert.match((await invoke('list')).stdout, /user\s/)
  assert.match((await invoke('list')).stdout, /project\s/)
  await invoke('uninstall', './package with spaces', '--local')
  assert.deepEqual(JSON.parse(await readFile(project, 'utf8')).packages, [])
  global = JSON.parse(await readFile(path.join(agent, 'settings.json'), 'utf8'))
  assert.equal(global.packages.length, 1)
  await invoke('remove', './package with spaces')
  assert.deepEqual(JSON.parse(await readFile(path.join(agent, 'settings.json'), 'utf8')).packages, [])
  for (const file of [path.join(cwd, '.kinex/python'), path.join(root, 'data'), path.join(agent, 'auth.json')]) {
    await assert.rejects(stat(file), { code: 'ENOENT' })
  }
})

test('malformed settings and failed package installation leave declarations unchanged', async t => {
  const { cwd, agent, invoke, configure } = await fixture(t)
  await configure({ packages: 'invalid' })
  await assert.rejects(invoke('install', 'npm:fixture'), error => /packages must be an array/.test(error.stderr))
  const failure = path.join(cwd, 'fail.cjs')
  await writeFile(failure, 'process.stderr.write("NPM_FIXTURE_FAILURE"); process.exit(17)')
  const original = { packages: [], theme: 'dark', npmCommand: [process.execPath, failure] }
  await configure(original)
  await assert.rejects(invoke('install', 'npm:fixture'), error => /NPM_FIXTURE_FAILURE|failed/.test(error.stderr))
  assert.deepEqual(JSON.parse(await readFile(path.join(agent, 'settings.json'), 'utf8')), original)
})

test('npm packages install in both scopes, update unpinned versions and preserve pinned overrides', { timeout: 90000 }, async t => {
  const { root, cwd, agent, env, invoke, configure } = await fixture(t)
  const pkg = path.join(root, 'npm-source')
  await mkdir(pkg)
  const archives = new Map()
  for (const version of ['1.0.0', '2.0.0']) {
    await writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: 'pi-managed-fixture', version, pi: { extensions: ['./index.ts'] } }))
    await writeFile(path.join(pkg, 'index.ts'), 'throw new Error("INSTALL_MUST_NOT_LOAD_EXTENSIONS")')
    const packed = JSON.parse((await exec('npm', ['pack', '--json', '--pack-destination', root], { cwd: pkg, env })).stdout)[0]
    archives.set(version, await readFile(path.join(root, packed.filename)))
  }
  let latest = '1.0.0'
  const server = createServer((req, res) => {
    const version = req.url.match(/^\/fixture-(.*)\.tgz$/)?.[1]
    if (version && archives.has(version)) { res.end(archives.get(version)); return }
    if (req.url !== '/pi-managed-fixture') { res.writeHead(404); res.end('{}'); return }
    const versions = Object.fromEntries([...archives].map(([version, bytes]) => [version, {
      name: 'pi-managed-fixture', version,
      dist: { tarball: `http://127.0.0.1:${server.address().port}/fixture-${version}.tgz`, shasum: createHash('sha1').update(bytes).digest('hex') },
    }]))
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ name: 'pi-managed-fixture', 'dist-tags': { latest }, versions }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  env.npm_config_registry = `http://127.0.0.1:${server.address().port}`
  await configure({ packages: [], theme: 'dark' })
  await invoke('install', 'npm:pi-managed-fixture')
  await invoke('install', 'npm:pi-managed-fixture@1.0.0', '-l')
  const globalManifest = path.join(agent, 'npm/node_modules/pi-managed-fixture/package.json')
  const projectManifest = path.join(cwd, '.pi/npm/node_modules/pi-managed-fixture/package.json')
  assert.equal(JSON.parse(await readFile(globalManifest, 'utf8')).version, '1.0.0')
  latest = '2.0.0'
  await invoke('update')
  assert.equal(JSON.parse(await readFile(globalManifest, 'utf8')).version, '2.0.0')
  assert.equal(JSON.parse(await readFile(projectManifest, 'utf8')).version, '1.0.0')
  await invoke('install', 'npm:pi-managed-fixture@2.0.0', '-l')
  assert.equal(JSON.parse(await readFile(projectManifest, 'utf8')).version, '2.0.0')
  await invoke('remove', 'npm:pi-managed-fixture', '-l')
  await assert.rejects(stat(projectManifest), { code: 'ENOENT' })
  assert.equal(JSON.parse(await readFile(globalManifest, 'utf8')).version, '2.0.0')
  await assert.rejects(stat(path.join(cwd, '.pi/settings.json')), { code: 'ENOENT' })
})

test('Git packages use Pi project paths and respect pinned refs during updates', { timeout: 90000 }, async t => {
  const { root, cwd, env, invoke } = await fixture(t)
  const repo = path.join(root, 'git-source')
  await mkdir(repo)
  const git = (...args) => exec('git', args, { cwd: repo, env })
  await git('init', '-b', 'main')
  await writeFile(path.join(repo, 'marker.txt'), 'first')
  await git('add', '.')
  await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'first')
  await git('tag', 'v1')
  env.GIT_CONFIG_COUNT = '1'
  env.GIT_CONFIG_KEY_0 = `url.file://${repo}.insteadOf`
  env.GIT_CONFIG_VALUE_0 = 'https://example.test/owner/fixture'
  env.GIT_TERMINAL_PROMPT = '0'
  await invoke('install', 'git:example.test/owner/fixture@v1', '-l')
  const marker = path.join(cwd, '.pi/git/example.test/owner/fixture/marker.txt')
  assert.equal(await readFile(marker, 'utf8'), 'first')
  await writeFile(path.join(repo, 'marker.txt'), 'second')
  await git('add', '.')
  await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'second')
  await invoke('update')
  assert.equal(await readFile(marker, 'utf8'), 'first')
  await invoke('install', 'git:example.test/owner/fixture', '-l')
  await invoke('update', 'git:example.test/owner/fixture')
  assert.equal(await readFile(marker, 'utf8'), 'second')
  await invoke('remove', 'git:example.test/owner/fixture', '-l')
  await assert.rejects(stat(marker), { code: 'ENOENT' })
})

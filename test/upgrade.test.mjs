import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile, rm, stat, symlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { upgradeKinex } from '../dist/upgrade.js'

const exec = promisify(execFile)

async function fixture(t, version = '0.10.4') {
  const root = await mkdtemp(path.join(tmpdir(), 'kinex-upgrade-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const prefix = path.join(root, 'install with spaces')
  const packageRoot = path.join(prefix, 'node_modules/kinex')
  await mkdir(packageRoot, { recursive: true })
  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'kinex', version: '0.10.3' }))
  await writeFile(path.join(prefix, 'package.json'), JSON.stringify({ dependencies: { kinex: '0.10.3' } }))
  const calls = [], downloads = [], reports = []
  const names = [`kinex-core-${version}.tgz`, `kinex-setup-${version}.tgz`, `kinex-${version}.tgz`]
  const artifacts = new Map(names.map(name => [name, Buffer.from(`archive:${name}`)]))
  const release = { draft: false, prerelease: false, tag_name: `v${version}`,
    assets: [...names, 'SHA256SUMS'].map(name => ({ name, browser_download_url: `https://github.com/stacx-lab/kinex/releases/download/v${version}/${name}` })) }
  const checksums = () => [...artifacts].map(([name, bytes]) => `${createHash('sha256').update(bytes).digest('hex')}  ${name}`).join('\n')
  const options = {
    cwd: root, packageRoot, dataDir: path.join(root, 'data'), report: message => reports.push(message),
    run: async (command, args, cwd, inherit) => {
      calls.push({ command, args, cwd, inherit })
      if (args[0] === 'root') return path.join(root, 'global/lib/node_modules')
      return ''
    },
    fetch: async url => {
      downloads.push(url)
      if (url.endsWith('/releases/latest')) return Response.json(release)
      if (url.endsWith('/SHA256SUMS')) return new Response(checksums())
      return new Response(artifacts.get(path.basename(url)))
    },
  }
  return { root, prefix, packageRoot, calls, downloads, reports, names, artifacts, release, options }
}

test('self-upgrade verifies and retains all three archives, installs together, then hands off --all', async t => {
  const f = await fixture(t)
  await upgradeKinex({ ...f.options, all: true })
  const install = f.calls.find(call => call.args[0] === 'install')
  assert.deepEqual(install.args.slice(0, 6), ['install', '--prefix', f.prefix, '--ignore-scripts', '--no-audit', '--no-fund'])
  assert.equal(install.args.length, 9)
  for (const file of install.args.slice(6)) assert.deepEqual(await readFile(file), f.artifacts.get(path.basename(file)))
  assert.deepEqual(f.calls.at(-1).args, [path.join(f.packageRoot, 'bin/kinex.mjs'), 'update'])
  assert.match(f.reports.at(-1), /Upgraded Kinex to 0\.10\.4/)
})

test('global install retains its npm prefix', async t => {
  const f = await fixture(t)
  const original = f.options.run
  f.options.run = async (command, args, ...rest) => {
    if (args[0] === 'root') return path.dirname(f.packageRoot)
    if (args[0] === 'prefix') return f.prefix
    return original(command, args, ...rest)
  }
  await upgradeKinex(f.options)
  assert.deepEqual(f.calls[0].args.slice(0, 4), ['install', '--global', '--prefix', f.prefix])
})

for (const version of ['0.10.3', '0.10.2']) {
  test(`release ${version} does not reinstall or downgrade and --all still updates packages`, async t => {
    const f = await fixture(t, version)
    await upgradeKinex({ ...f.options, all: true })
    assert.equal(f.downloads.length, 1)
    assert.ok(!f.calls.some(call => call.args[0] === 'install'))
    assert.equal(f.calls.at(-1).args.at(-1), 'update')
    await assert.rejects(stat(f.options.dataDir), { code: 'ENOENT' })
  })
}

for (const failure of ['missing asset', 'checksum mismatch', 'missing checksum', 'download failure', 'prerelease']) {
  test(`${failure} fails before changing the installation or starting package updates`, async t => {
    const f = await fixture(t)
    const original = f.options.fetch
    if (failure === 'missing asset') f.release.assets.pop()
    if (failure === 'prerelease') f.release.prerelease = true
    f.options.fetch = async url => {
      if (failure === 'checksum mismatch' && url.endsWith(f.names[2])) return new Response('corrupt')
      if (failure === 'missing checksum' && url.endsWith('SHA256SUMS')) return new Response('')
      if (failure === 'download failure' && url.endsWith(f.names[0])) return new Response('', { status: 503 })
      return original(url)
    }
    await assert.rejects(upgradeKinex({ ...f.options, all: true }), /asset|checksum|SHA256SUMS|Download failed|stable Kinex/i)
    assert.equal(f.calls.length, 1, 'only read-only npm root probe ran')
    assert.equal(JSON.parse(await readFile(path.join(f.packageRoot, 'package.json'), 'utf8')).version, '0.10.3')
    await assert.rejects(stat(f.options.dataDir), { code: 'ENOENT' })
  })
}

test('source checkouts and symlinked installs receive instructions without network or npm operations', async t => {
  const f = await fixture(t)
  const source = path.join(f.root, 'source')
  await mkdir(source)
  const link = path.join(f.root, 'linked/node_modules/kinex')
  await mkdir(path.dirname(link), { recursive: true })
  await symlink(source, link)
  for (const packageRoot of [source, link]) {
    await assert.rejects(upgradeKinex({ ...f.options, packageRoot }), /npm ci and npm run build/)
  }
  assert.equal(f.calls.length, 0)
  assert.equal(f.downloads.length, 0)
})

test('failed npm upgrade retains recovery artifacts and does not continue to package updates', async t => {
  const f = await fixture(t)
  const original = f.options.run
  f.options.run = async (command, args, ...rest) => {
    await original(command, args, ...rest)
    if (args[0] === 'install') throw new Error('simulated npm failure')
    return path.join(f.root, 'global/lib/node_modules')
  }
  await assert.rejects(upgradeKinex({ ...f.options, all: true }), /partially changed.*Retry: npm.*simulated npm failure/s)
  assert.equal(f.calls.length, 2)
  assert.equal(f.reports.some(message => message.startsWith('Upgraded')), false)
  for (const name of f.names) await stat(path.join(f.options.dataDir, 'releases/0.10.4', name))
})

test('verified release tarballs upgrade an actual local npm installation and persist usable file references', { timeout: 60000 }, async t => {
  const f = await fixture(t)
  for (const [name, index] of [['@kinex/core', 0], ['@kinex/setup', 1], ['kinex', 2]]) {
    const source = path.join(f.root, `package-${index}`)
    await mkdir(path.join(source, 'bin'), { recursive: true })
    await writeFile(path.join(source, 'package.json'), JSON.stringify({
      name, version: '0.10.4', type: 'module',
      ...(index === 2 ? { bin: { kinex: 'bin/kinex.mjs' }, dependencies: { '@kinex/core': '0.10.4', '@kinex/setup': '0.10.4' } } : {}),
      scripts: { postinstall: 'node -e "process.exit(99)"' },
    }))
    await writeFile(path.join(source, 'bin/kinex.mjs'), '#!/usr/bin/env node\nconsole.log("NEW_CLI:" + process.argv[2])')
    const packed = JSON.parse((await exec('npm', ['pack', '--json', '--pack-destination', f.root], { cwd: source })).stdout)[0]
    f.artifacts.set(f.names[index], await readFile(path.join(f.root, packed.filename)))
  }
  const output = []
  f.options.run = async (command, args, cwd) => {
    const result = await exec(command, args, { cwd })
    output.push(result.stdout)
    return result.stdout.trim()
  }
  await upgradeKinex({ ...f.options, all: true })
  assert.ok(output.some(text => text.includes('NEW_CLI:update')))
  for (const name of ['kinex', '@kinex/core', '@kinex/setup']) {
    assert.equal(JSON.parse(await readFile(path.join(f.prefix, 'node_modules', name, 'package.json'), 'utf8')).version, '0.10.4')
  }
  const consumer = JSON.parse(await readFile(path.join(f.prefix, 'package.json'), 'utf8'))
  for (const spec of Object.values(consumer.dependencies)) {
    assert.match(spec, /^file:/)
    await stat(path.resolve(f.prefix, spec.slice(5)))
  }
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile, rm, stat, chmod } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const exec = promisify(execFile)
const installer = fileURLToPath(new URL('../install.sh', import.meta.url))
const pty = fileURLToPath(new URL('./fixtures/tui_pty.py', import.meta.url))
const quote = value => `'${value.replaceAll("'", "'\\''")}'`
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

async function executable(file, source) {
  await writeFile(file, source)
  await chmod(file, 0o755)
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kinex-installer-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const home = path.join(root, "home with ' spaces")
  const data = path.join(home, 'data')
  const bin = path.join(root, 'commands')
  await mkdir(bin, { recursive: true })
  await mkdir(home, { recursive: true })
  const env = { ...process.env, HOME: home, SHELL: '/bin/bash', KINEX_DATA_DIR: data,
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'),
    PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    npm_config_cache: path.join(root, 'npm-cache'), npm_config_userconfig: path.join(root, 'npmrc'),
    KINEX_TEST_ROOT: root }
  await executable(path.join(bin, 'curl'), `#!${process.execPath}
import('node:fs').then(fs => {
  const args = process.argv.slice(2), root = process.env.KINEX_TEST_ROOT;
  const url = args.find(arg => arg.startsWith('https://'));
  fs.appendFileSync(root + '/downloads', url + '\\n');
  const name = url.endsWith('/releases/latest') ? 'release.json' : url.split('/').at(-1);
  const bytes = fs.readFileSync(root + '/' + name);
  const output = args.indexOf('-o');
  if (output >= 0) fs.writeFileSync(args[output + 1], bytes); else process.stdout.write(bytes);
}).catch(error => { console.error(error.message); process.exitCode = 22; });
`)
  const run = (code = 'main', options = {}) => exec('bash', ['-c', `source ${quote(installer)}\n${code}`], { env, cwd: root, detached: true, timeout: 30000, ...options })
  const release = async (version = '0.10.4', packed = false) => {
    const names = [`kinex-core-${version}.tgz`, `kinex-setup-${version}.tgz`, `kinex-${version}.tgz`]
    const assets = [...names, 'SHA256SUMS'].map(name => ({ name, browser_download_url: `https://github.com/stacx-lab/kinex/releases/download/v${version}/${name}` }))
    await writeFile(path.join(root, 'release.json'), JSON.stringify({ draft: false, prerelease: false, tag_name: `v${version}`, assets }))
    const sums = []
    for (const [index, name] of names.entries()) {
      if (packed) {
        const source = path.join(root, `source-${index}`)
        await mkdir(path.join(source, 'bin'), { recursive: true })
        await writeFile(path.join(source, 'package.json'), JSON.stringify({
          name: ['@kinex/core', '@kinex/setup', 'kinex'][index], version, type: 'module',
          ...(index === 2 ? { bin: { kinex: 'bin/kinex.mjs' }, dependencies: { '@kinex/core': version, '@kinex/setup': version } } : {}),
          scripts: { postinstall: 'node -e "process.exit(99)"' },
        }))
        await writeFile(path.join(source, 'bin/kinex.mjs'), `#!/usr/bin/env node\nconsole.log(${JSON.stringify(version)} + ':' + process.argv.slice(2).join(','))`)
        await exec('npm', ['pack', '--json', '--pack-destination', root], { cwd: source, env })
      } else await writeFile(path.join(root, name), `archive:${name}`)
      sums.push(`${digest(await readFile(path.join(root, name)))}  ${name}`)
    }
    await writeFile(path.join(root, 'SHA256SUMS'), sums.join('\n') + '\n')
    return names
  }
  return { root, home, data, bin, env, run, release }
}

test('installer parses as Bash and pipes into bash with a usable existing Node', async t => {
  const f = await fixture(t)
  await exec('bash', ['-n', installer])
  // The release error proves pipe mode reaches installation, without asking to install Node.
  await writeFile(path.join(f.root, 'release.json'), '{}')
  await assert.rejects(exec('bash', ['-c', 'cat "$1" | bash', 'test', installer], { env: f.env, detached: true }), error => {
    assert.match(error.stderr, /Expected a stable Kinex release/)
    assert.doesNotMatch(error.stderr, /needs Node|No terminal/)
    return true
  })
})

test('missing/old Node fails without a terminal, and refusing installation has no effects', async t => {
  const f = await fixture(t)
  await executable(path.join(f.bin, 'node'), '#!/bin/sh\nexit 1\n')
  await assert.rejects(f.run(), /Install Node >=22\.19 and npm/)
  await assert.rejects(stat(f.data), { code: 'ENOENT' })
  await assert.rejects(stat(path.join(f.root, 'downloads')), { code: 'ENOENT' })
  await assert.rejects(f.run('confirm() { return 1; }\nprepare_node "$KINEX_DATA_DIR"'), /Install Node >=22\.19 and npm/)
  // Missing npm is independently rejected, even with a supported Node.
  await rm(path.join(f.bin, 'node'))
  await executable(path.join(f.bin, 'npm'), '#!/bin/sh\nexit 1\n')
  await assert.rejects(f.run('confirm() { return 1; }\nprepare_node "$KINEX_DATA_DIR"'), /Install Node >=22\.19 and npm/)
})

test('installation confirmation reads acceptance and refusal from the terminal', async t => {
  const f = await fixture(t)
  for (const [answer, expected] of [['n\r', 'DECLINED'], ['\r', 'ACCEPTED']]) {
    const code = `source ${quote(installer)}
if confirm 'Install test Node?' 'No terminal'; then printf ACCEPTED; else printf DECLINED; fi`
    const { stdout } = await exec('python3', [pty, 'bash', '-c', code], {
      cwd: f.root, timeout: 10000,
      env: { ...f.env, TUI_TEST_TIMEOUT: '5', TUI_TEST_TRIGGER: 'Install test Node?',
        TUI_TEST_KEYS: JSON.stringify([[0, answer]]) },
    })
    assert.match(stdout, new RegExp(expected))
  }
})

test('Node installation selects Homebrew, suitable apt/apk, then standalone', async t => {
  const f = await fixture(t)
  const choose = async (platform, apt, apk, brew = false) => {
    const commands = `
command() { case "$2" in
  brew) ${brew ? 'return 0' : 'return 1'} ;;
  apt-get|apt-cache) ${apt ? 'return 0' : 'return 1'} ;;
  apk) ${apk ? 'return 0' : 'return 1'} ;;
  *) builtin command "$@" ;;
esac; }
uname() { printf '%s' ${quote(platform)}; }
apt-cache() { printf 'Candidate: %s\\n' ${quote(apt || '(none)')}; }
apk() { printf 'nodejs-%s-r0\\n' ${quote(apk || '')}; }
node_install_method`
    return (await f.run(commands)).stdout
  }
  assert.equal(await choose('Darwin', null, null, true), 'homebrew')
  assert.equal(await choose('Darwin', null, null), 'standalone')
  assert.equal(await choose('Linux', '22.19.0-1', null), 'apt')
  assert.equal(await choose('Linux', '18.20.0-1', '24.1.0'), 'apk')
  assert.equal(await choose('Linux', '18.20.0-1', '20.1.0'), 'standalone')
  assert.equal(await choose('Linux', '(none)', null), 'standalone')
})

test('confirmed package-manager installation routes through the selected manager and rechecks Node', async t => {
  const f = await fixture(t)
  for (const method of ['homebrew', 'apt', 'apk']) {
    const result = await f.run(`
checks=0
node_ready() { checks=$((checks + 1)); (( checks > 1 )); }
node_install_method() { printf '%s' ${quote(method)}; }
confirm() { return 0; }
as_root() { printf '%s\\n' "$*"; }
brew() { if [[ $1 == list ]]; then return 1; fi; printf '%s\\n' "brew $*"; }
prepare_node "$KINEX_DATA_DIR"
printf 'checks=%s\\n' "$checks"`)
    assert.match(result.stdout, { homebrew: /brew install node/, apt: /apt-get update\napt-get install -y nodejs npm/, apk: /apk add --update-cache nodejs npm/ }[method])
    assert.match(result.stdout, /checks=2/)
  }
})

async function nodeArchive(f) {
  const platform = os.platform() === 'darwin' ? 'darwin' : 'linux'
  const arch = os.arch() === 'arm64' ? 'arm64' : 'x64'
  const name = `node-v22.19.0-${platform}-${arch}`
  const source = path.join(f.root, 'node-source', name, 'bin')
  await mkdir(source, { recursive: true })
  await executable(path.join(source, 'node'), `#!/bin/sh\nexec ${quote(process.execPath)} "$@"\n`)
  const npm = (await exec('which', ['npm'])).stdout.trim()
  await executable(path.join(source, 'npm'), `#!/bin/sh\nexec ${quote(npm)} "$@"\n`)
  await exec('tar', ['-czf', path.join(f.root, `${name}.tar.gz`), '-C', path.dirname(path.dirname(source)), name])
  await writeFile(path.join(f.root, 'SHASUMS256.txt'), `${digest(await readFile(path.join(f.root, `${name}.tar.gz`)))}  ${name}.tar.gz\n`)
  return name
}

test('standalone Node verifies its archive, remains user-local and is reused', async t => {
  const f = await fixture(t)
  await nodeArchive(f)
  await executable(path.join(f.bin, 'node'), '#!/bin/sh\nexit 1\n')
  await f.run(`confirm() { return 0; }
node_install_method() { printf standalone; }
prepare_node "$KINEX_DATA_DIR"
node_ready`)
  await stat(path.join(f.data, 'node/current/bin/node'))
  const before = await readFile(path.join(f.root, 'downloads'), 'utf8')
  await f.run('confirm() { exit 99; }\nprepare_node "$KINEX_DATA_DIR"\nnode_ready')
  assert.equal(await readFile(path.join(f.root, 'downloads'), 'utf8'), before)
  await assert.rejects(stat(path.join(f.home, '.profile')), { code: 'ENOENT' })
})

test('corrupt standalone Node is rejected before activation', async t => {
  const f = await fixture(t)
  const name = await nodeArchive(f)
  await writeFile(path.join(f.root, `${name}.tar.gz`), 'corrupt')
  await assert.rejects(f.run('install_node_standalone "$KINEX_DATA_DIR"'), /Node checksum mismatch/)
  await assert.rejects(stat(path.join(f.data, 'node/current')), { code: 'ENOENT' })
})

for (const failure of ['missing asset', 'checksum', 'download', 'prerelease']) {
  test(`release ${failure} fails before modifying an installation`, async t => {
    const f = await fixture(t)
    const names = await f.release()
    if (failure === 'checksum') await writeFile(path.join(f.root, names[1]), 'corrupt')
    if (failure === 'download') await rm(path.join(f.root, names[1]))
    if (failure === 'missing asset' || failure === 'prerelease') {
      const file = path.join(f.root, 'release.json'), release = JSON.parse(await readFile(file, 'utf8'))
      if (failure === 'missing asset') release.assets.pop()
      else release.prerelease = true
      await writeFile(file, JSON.stringify(release))
    }
    await assert.rejects(f.run())
    await assert.rejects(stat(f.data), { code: 'ENOENT' })
    await assert.rejects(stat(path.join(f.home, '.local/bin/kinex')), { code: 'ENOENT' })
  })
}

test('installer preserves foreign launchers, PATH entries and install directories', async t => {
  for (const conflict of ['launcher', 'path', 'directory']) {
    const f = await fixture(t)
    const file = conflict === 'launcher' ? path.join(f.home, '.local/bin/kinex')
      : conflict === 'path' ? path.join(f.bin, 'kinex') : path.join(f.data, 'install/package.json')
    await mkdir(path.dirname(file), { recursive: true })
    await executable(file, conflict === 'directory' ? '{}' : '#!/bin/sh\nexit 0\n')
    const original = await readFile(file, 'utf8')
    await assert.rejects(f.run(), /Refusing|Another Kinex/)
    assert.equal(await readFile(file, 'utf8'), original)
    await assert.rejects(stat(path.join(f.root, 'downloads')), { code: 'ENOENT' })
  }
})

test('npm failure preserves verified archives and reports a retry command', async t => {
  const f = await fixture(t)
  const names = await f.release()
  await executable(path.join(f.bin, 'npm'), '#!/bin/sh\nif [ "$1" = --version ]; then echo 10; else exit 42; fi\n')
  await assert.rejects(f.run(), error => {
    assert.match(error.stderr, /partially changed.*Retry with Node\/npm on PATH:/s)
    assert.match(error.stderr, /npm 'install' '--prefix'/)
    return true
  })
  for (const name of names) await stat(path.join(f.data, 'releases/0.10.4', name))
  await assert.rejects(stat(path.join(f.home, '.local/bin/kinex')), { code: 'ENOENT' })
})

test('PATH configuration honors refusal, supports supported shells and does not duplicate entries', async t => {
  const f = await fixture(t)
  await f.run('confirm() { return 1; }\nconfigure_path')
  await assert.rejects(stat(path.join(f.home, '.profile')), { code: 'ENOENT' })
  for (const [shell, config] of [['bash', '.profile'], ['zsh', '.zshrc'], ['fish', '.config/fish/config.fish']]) {
    const options = { env: { ...f.env, SHELL: `/bin/${shell}` } }
    await f.run('confirm() { return 0; }\nconfigure_path\nconfigure_path', options)
    const contents = await readFile(path.join(f.home, config), 'utf8')
    assert.equal(contents.match(/# Kinex/g).length, 1)
    assert.match(contents, shell === 'fish' ? /fish_add_path/ : /export PATH/)
  }
})

test('real npm installation launches, retains archives, avoids downgrades and supports self-upgrade', { timeout: 60000 }, async t => {
  const f = await fixture(t)
  await f.release('0.10.4', true)
  await exec('bash', ['-c', 'cat "$1" | bash', 'test', installer], { env: f.env, cwd: f.root, detached: true, timeout: 30000 })
  const launcher = path.join(f.home, '.local/bin/kinex')
  const installed = path.join(f.data, 'install/node_modules/kinex')
  assert.match((await exec(launcher, ['--version'], { env: f.env })).stdout, /0\.10\.4:--version/)
  const before = await readFile(path.join(f.root, 'downloads'), 'utf8')
  await f.release('0.10.3')
  await f.run()
  const added = (await readFile(path.join(f.root, 'downloads'), 'utf8')).slice(before.length)
  assert.equal(added.trim().split('\n').length, 1, 'older release only fetches metadata')
  assert.equal(JSON.parse(await readFile(path.join(installed, 'package.json'))).version, '0.10.4')
  await f.release('0.10.5', true)
  const { upgradeKinex } = await import('../dist/upgrade.js')
  const calls = []
  await upgradeKinex({
    cwd: f.root, packageRoot: installed, dataDir: f.data, report() {},
    fetch: async url => new Response(await readFile(path.join(f.root, url.endsWith('/releases/latest') ? 'release.json' : path.basename(url)))),
    run: async (command, args, cwd) => {
      calls.push(args)
      return (await exec(command, args, { cwd, env: f.env })).stdout.trim()
    },
  })
  assert.ok(calls.some(args => args[0] === 'install' && args[1] === '--prefix' && args[2] === path.join(f.data, 'install')))
  assert.match((await exec(launcher, ['--version'], { env: f.env })).stdout, /0\.10\.5:--version/)
  const consumer = JSON.parse(await readFile(path.join(f.data, 'install/package.json'), 'utf8'))
  for (const reference of Object.values(consumer.dependencies)) {
    assert.match(reference, /^file:/)
    await stat(path.resolve(f.data, 'install', reference.slice(5)))
  }
})

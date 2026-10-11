#!/usr/bin/env bash
# Install Kinex from its stable GitHub release. Safe to run through curl | bash.
set -euo pipefail

fail() { printf 'Kinex: %s\n' "$*" >&2; exit 1; }

confirm() {
  local answer
  if ! ( : <> /dev/tty ) 2>/dev/null; then
    printf 'No terminal detected. %s\n' "$2" >&2
    return 1
  fi
  printf '%s [Y/n] ' "$1" > /dev/tty
  IFS= read -r answer < /dev/tty || return 1
  case "$answer" in n|N|no|NO) return 1 ;; esac
}

node_version_ok() {
  local version=${1#v} major minor
  version=${version%%[!0-9.]*}
  IFS=. read -r major minor _ <<< "$version"
  [[ $major =~ ^[0-9]+$ && ${minor:-0} =~ ^[0-9]+$ ]] || return 1
  (( 10#$major > 22 || (10#$major == 22 && 10#${minor:-0} >= 19) ))
}

node_ready() {
  command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 &&
    node -e 'const [a,b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 19) ? 0 : 1)' >/dev/null 2>&1 &&
    npm --version >/dev/null 2>&1
}

node_install_method() {
  local candidate
  case "$(uname -s)" in
    Darwin)
      if command -v brew >/dev/null 2>&1; then printf 'homebrew'; return; fi ;;
    Linux)
      if command -v apt-get >/dev/null 2>&1 && command -v apt-cache >/dev/null 2>&1; then
        candidate=$(apt-cache policy nodejs 2>/dev/null | awk '/Candidate:/ { print $2; exit }')
        if node_version_ok "$candidate"; then printf 'apt'; return; fi
      fi
      if command -v apk >/dev/null 2>&1; then
        candidate=$(apk search -x nodejs 2>/dev/null | awk -F- '/^nodejs-/ { print $2; exit }')
        if node_version_ok "$candidate"; then printf 'apk'; return; fi
      fi ;;
  esac
  printf 'standalone'
}

as_root() {
  if [[ $(id -u) == 0 ]]; then "$@"; else
    command -v sudo >/dev/null 2>&1 || fail 'sudo is required for this package manager; install Node >=22.19 and npm, then retry.'
    sudo "$@"
  fi
}

install_node_standalone() (
  local data=$1 platform arch temporary filename expected actual base destination
  case "$(uname -s)" in Darwin) platform=darwin ;; Linux) platform=linux ;; *) fail 'Unsupported operating system.' ;; esac
  case "$(uname -m)" in
    x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; armv7l|ppc64le|s390x) arch=$(uname -m) ;;
    *) fail 'No supported Node binary for this architecture; install Node >=22.19 and npm manually.' ;;
  esac
  command -v tar >/dev/null 2>&1 || fail 'tar is required to extract Node.'
  temporary=$(mktemp -d)
  trap 'rm -rf "$temporary"' EXIT
  base=https://nodejs.org/dist/latest-v22.x
  curl -fsSL --connect-timeout 15 --max-time 120 "$base/SHASUMS256.txt" -o "$temporary/sums"
  filename=$(awk -v suffix="-$platform-$arch.tar.gz" '$2 ~ /^node-v22\.[0-9]+\.[0-9]+-/ && substr($2, length($2)-length(suffix)+1) == suffix {print $2}' "$temporary/sums")
  [[ $filename =~ ^node-v22\.[0-9]+\.[0-9]+-[a-z0-9]+-[a-z0-9]+\.tar\.gz$ ]] || fail 'No unique Node archive found for this platform.'
  expected=$(awk -v name="$filename" '$2 == name {print $1}' "$temporary/sums")
  [[ $expected =~ ^[a-fA-F0-9]{64}$ ]] || fail 'Invalid Node checksum.'
  printf 'Downloading %s...\n' "$filename"
  curl -fsSL --connect-timeout 15 --max-time 300 "$base/$filename" -o "$temporary/$filename"
  if command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$temporary/$filename")
  elif command -v shasum >/dev/null 2>&1; then
    actual=$(shasum -a 256 "$temporary/$filename")
  else
    fail 'sha256sum or shasum is required to verify Node.'
  fi
  [[ ${actual%% *} == "$expected" ]] || fail 'Node checksum mismatch.'
  tar -xzf "$temporary/$filename" -C "$temporary"
  destination="$data/node/${filename%.tar.gz}"
  if [[ ! -e $destination ]]; then
    mkdir -p "$data/node"
    mv "$temporary/${filename%.tar.gz}" "$destination"
  fi
  "$destination/bin/node" -e 'const [a,b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 19) ? 0 : 1)' || fail 'Downloaded Node cannot run on this host.'
  if [[ -e $data/node/current && ! -L $data/node/current ]]; then fail "Refusing to replace $data/node/current"; fi
  ln -sfn "${filename%.tar.gz}" "$data/node/current"
)

prepare_node() {
  local data=$1 method
  if node_ready; then return; fi
  if [[ -x $data/node/current/bin/node && -x $data/node/current/bin/npm ]]; then
    export PATH="$data/node/current/bin:$PATH"
    if node_ready; then return; fi
  fi
  method=$(node_install_method)
  confirm "Kinex needs Node >=22.19 and npm. Install them using $method?" \
    'Install Node >=22.19 and npm, then run this installer again.' || fail 'Install Node >=22.19 and npm, then retry.'
  case "$method" in
    homebrew)
      if brew list node >/dev/null 2>&1; then brew upgrade node; else brew install node; fi ;;
    apt) as_root apt-get update; as_root apt-get install -y nodejs npm ;;
    apk) as_root apk add --update-cache nodejs npm ;;
    standalone) install_node_standalone "$data"; export PATH="$data/node/current/bin:$PATH" ;;
  esac
  hash -r
  node_ready || fail 'Node/npm are still unavailable or too old. Check your PATH and retry.'
}

install_kinex() {
  node --input-type=module - "$1" "$2" <<'JS'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync, mkdirSync, mkdtempSync, copyFileSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const data = path.resolve(process.argv[2]);
const nodeBin = process.argv[3];
const prefix = path.join(data, 'install');
const bin = path.join(os.homedir(), '.local/bin/kinex');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const owner = `kinex_install_root=${quote(prefix)}\n`;
const launcher = `#!/bin/sh\n# Kinex managed launcher\n${owner}export PATH=${quote(nodeBin)}:"$PATH"\nexec node "$kinex_install_root/node_modules/kinex/bin/kinex.mjs" "$@"\n`;
const download = (url, output) => execFileSync('curl', [
  '-fsSL', '--connect-timeout', '15', '--max-time', '300',
  '-H', 'User-Agent: kinex-installer', url, ...(output ? ['-o', output] : []),
], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] });
const versionParts = version => {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('Invalid stable release version');
  const parts = version.split('.').map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new Error('Invalid stable release version');
  return parts;
};
const exists = file => { try { lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
let temporary;
try {
  if (exists(bin) && (lstatSync(bin).isSymbolicLink() || !lstatSync(bin).isFile() ||
    !readFileSync(bin, 'utf8').startsWith(`#!/bin/sh\n# Kinex managed launcher\n${owner}`))) {
    throw new Error(`Refusing to replace ${bin}. Remove or relocate the existing entry first.`);
  }
  const active = execFileSync('bash', ['-c', 'command -v kinex || true'], { encoding: 'utf8' }).trim();
  if (active && (!exists(bin) || realpathSync(active) !== realpathSync(bin))) {
    throw new Error(`Another Kinex is on PATH: ${active}. Update it with kinex update, or remove it before installing here.`);
  }
  const manifest = path.join(prefix, 'package.json');
  if (exists(prefix)) {
    const saved = existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8'));
    if (!saved || saved.name !== 'kinex-installation' || saved.private !== true) throw new Error(`Refusing to use an unrelated directory: ${prefix}`);
  }
  const release = JSON.parse(download('https://api.github.com/repos/stacx-lab/kinex/releases/latest'));
  if (release.draft !== false || release.prerelease !== false || typeof release.tag_name !== 'string' || !release.tag_name.startsWith('v')) throw new Error('Expected a stable Kinex release');
  const version = release.tag_name.slice(1), target = versionParts(version);
  const installedFile = path.join(prefix, 'node_modules/kinex/package.json');
  let install = true;
  if (existsSync(installedFile)) {
    const currentVersion = JSON.parse(readFileSync(installedFile, 'utf8')).version;
    const current = versionParts(currentVersion);
    install = (target.map((part, i) => part - current[i]).find(value => value !== 0) ?? 0) > 0;
    if (!install) console.log(`Kinex ${currentVersion} is already installed (latest: ${version}).`);
  }
  if (install) {
    const names = [`kinex-core-${version}.tgz`, `kinex-setup-${version}.tgz`, `kinex-${version}.tgz`];
    const base = `https://github.com/stacx-lab/kinex/releases/download/v${version}`;
    for (const name of [...names, 'SHA256SUMS']) {
      const matches = Array.isArray(release.assets) ? release.assets.filter(asset => asset?.name === name) : [];
      if (matches.length !== 1 || matches[0].browser_download_url !== `${base}/${name}`) throw new Error(`Missing or invalid release asset: ${name}`);
    }
    const checksums = new Map();
    for (const line of download(`${base}/SHA256SUMS`).trim().split(/\r?\n/)) {
      const match = /^([a-fA-F0-9]{64})  (\S+)$/.exec(line);
      if (!match || checksums.has(match[2])) throw new Error('Invalid SHA256SUMS');
      checksums.set(match[2], match[1].toLowerCase());
    }
    temporary = mkdtempSync(path.join(os.tmpdir(), 'kinex-install-'));
    console.log(`Downloading Kinex ${version}...`);
    for (const name of names) {
      if (!checksums.has(name)) throw new Error(`Missing checksum: ${name}`);
      const file = path.join(temporary, name);
      download(`${base}/${name}`, file);
      if (createHash('sha256').update(readFileSync(file)).digest('hex') !== checksums.get(name)) throw new Error(`Checksum mismatch: ${name}`);
    }
    const cache = path.join(data, 'releases', version);
    mkdirSync(cache, { recursive: true });
    for (const name of names) {
      const staged = path.join(cache, `${name}.${process.pid}.tmp`);
      try { copyFileSync(path.join(temporary, name), staged); renameSync(staged, path.join(cache, name)); }
      finally { rmSync(staged, { force: true }); }
    }
    mkdirSync(prefix, { recursive: true });
    if (!existsSync(manifest)) writeFileSync(manifest, JSON.stringify({ name: 'kinex-installation', private: true }, null, 2) + '\n');
    const args = ['install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', ...names.map(name => path.join(cache, name))];
    try { execFileSync('npm', args, { cwd: prefix, stdio: ['ignore', 'inherit', 'inherit'] }); }
    catch { throw new Error(`npm may have partially changed the installation. Retry with Node/npm on PATH:\nnpm ${args.map(quote).join(' ')}`); }
  }
  execFileSync(process.execPath, [path.join(prefix, 'node_modules/kinex/bin/kinex.mjs'), '--version'], { stdio: ['ignore', 'inherit', 'inherit'] });
  mkdirSync(path.dirname(bin), { recursive: true });
  const staged = `${bin}.${process.pid}.tmp`;
  try { writeFileSync(staged, launcher, { mode: 0o755 }); renameSync(staged, bin); }
  finally { rmSync(staged, { force: true }); }
  console.log(`Installed ${bin}\nUpdate later with: kinex update`);
} catch (error) {
  console.error(`Kinex: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (temporary) rmSync(temporary, { recursive: true, force: true });
}
JS
}

configure_path() {
  local bin="$HOME/.local/bin" shell_name config command
  case ":$PATH:" in *":$bin:"*) return ;; esac
  shell_name=${SHELL:-sh}
  shell_name=${shell_name##*/}
  case "$shell_name" in
    zsh) config="${ZDOTDIR:-$HOME}/.zshrc"; command='export PATH="$HOME/.local/bin:$PATH"' ;;
    fish) config="${XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish"; command='fish_add_path "$HOME/.local/bin"' ;;
    *) config="$HOME/.profile"; [[ ! -f $HOME/.bashrc ]] || config="$HOME/.bashrc"; command='export PATH="$HOME/.local/bin:$PATH"' ;;
  esac
  if [[ -f $config ]] && grep -Fxq "$command" "$config"; then
    printf 'PATH is configured in %s.\n' "$config"
  elif confirm "Add $bin to PATH in $config?" "Add $bin to PATH before running kinex."; then
    mkdir -p "${config%/*}"
    printf '\n# Kinex\n%s\n' "$command" >> "$config"
  fi
  printf 'For this terminal, run:\n  %s\n' "$command"
}

main() {
  local data="${KINEX_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/kinex}" node_bin
  case "$(uname -s)" in Linux|Darwin) ;; *) fail 'The installer supports Linux and macOS.' ;; esac
  command -v curl >/dev/null 2>&1 || fail 'curl is required.'
  case "$data" in /*) ;; *) data="$PWD/$data" ;; esac
  prepare_node "$data"
  node_bin=$(dirname "$(command -v node)")
  install_kinex "$data" "$node_bin"
  configure_path
  printf '\nStart Kinex:\n  cd /path/to/project\n  kinex\n'
}

if [[ -z ${BASH_SOURCE[0]:-} || ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi

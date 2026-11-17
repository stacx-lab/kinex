import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile, realpath, rename, writeFile, rm } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { paths } from "./settings.ts"

type Run = (command: string, args: string[], cwd: string, inherit?: boolean) => Promise<string>

interface UpgradeOptions {
  all?: boolean
  cwd?: string
  packageRoot?: string
  dataDir?: string
  fetch?: typeof fetch
  run?: Run
  report?: (message: string) => void
}

const repository = "https://api.github.com/repos/stacx-lab/kinex"
const sourceInstructions = "Automatic upgrades require an npm release installation. For a source checkout or linked install, update the checkout, then run npm ci and npm run build with Node >=22.19. Do not run the release updater inside the source tree."

async function runCommand(command: string, args: string[], cwd: string, inherit = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"] })
    let stdout = "", stderr = ""
    child.stdout?.on("data", chunk => { stdout += String(chunk) })
    child.stderr?.on("data", chunk => { stderr += String(chunk) })
    child.once("error", reject)
    child.once("close", (code, signal) => {
      if (code === 0) resolve(stdout.trim())
      else reject(new Error(`${command} failed (${signal ?? code}): ${stderr.trim()}`))
    })
  })
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid release metadata")
  return value as Record<string, unknown>
}

function versionParts(value: unknown): number[] {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) throw new Error(`Invalid stable version: ${String(value)}`)
  const parts = value.split(".").map(Number)
  if (!parts.every(Number.isSafeInteger)) throw new Error(`Invalid stable version: ${value}`)
  return parts
}

async function installation(packageRoot: string, run: Run, cwd: string) {
  const root = await realpath(packageRoot)
  if (root !== path.resolve(packageRoot) || existsSync(path.join(root, ".git")) || path.basename(root) !== "kinex" || path.basename(path.dirname(root)) !== "node_modules") throw new Error(sourceInstructions)
  const manifest = object(JSON.parse(await readFile(path.join(root, "package.json"), "utf8")))
  if (manifest.name !== "kinex" || typeof manifest.version !== "string") throw new Error(sourceInstructions)
  versionParts(manifest.version)
  const modules = path.dirname(root)
  const globalModules = await run("npm", ["root", "--global"], cwd)
  if (modules === path.resolve(globalModules)) {
    const prefix = await run("npm", ["prefix", "--global"], cwd)
    return { root, version: manifest.version, args: ["--global", "--prefix", prefix] }
  }
  const prefix = path.dirname(modules)
  if (!existsSync(path.join(prefix, "package.json"))) throw new Error(sourceInstructions)
  const consumer = object(JSON.parse(await readFile(path.join(prefix, "package.json"), "utf8")))
  const direct = [consumer.dependencies, consumer.devDependencies, consumer.optionalDependencies]
    .some(dependencies => dependencies && typeof dependencies === "object" && Object.hasOwn(dependencies, "kinex"))
  if (!direct) throw new Error(sourceInstructions)
  return { root, version: manifest.version, args: ["--prefix", prefix] }
}

/** Upgrade the installed product, never independently replace its embedded SDK. */
export async function upgradeKinex(options: UpgradeOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd()
  const run = options.run ?? runCommand
  const report = options.report ?? console.log
  const request = options.fetch ?? fetch
  const installed = await installation(options.packageRoot ?? fileURLToPath(new URL("../", import.meta.url)), run, cwd)
  const download = async (url: string): Promise<Response> => {
    const response = await request(url, {
      headers: { "User-Agent": `kinex/${installed.version}` }, signal: AbortSignal.timeout(60_000),
    })
    if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`)
    return response
  }
  const release = object(await (await download(`${repository}/releases/latest`)).json())
  if (release.draft !== false || release.prerelease !== false || typeof release.tag_name !== "string" || !release.tag_name.startsWith("v")) throw new Error("Expected a stable Kinex GitHub release")
  const version = release.tag_name.slice(1)
  const target = versionParts(version), current = versionParts(installed.version)
  const difference = target.map((part, index) => part - current[index]!).find(value => value !== 0) ?? 0
  if (difference <= 0) {
    report(`Kinex ${installed.version} is current (latest release: ${version}).`)
  } else {
    const names = [`kinex-core-${version}.tgz`, `kinex-setup-${version}.tgz`, `kinex-${version}.tgz`]
    const assets = release.assets
    if (!Array.isArray(assets)) throw new Error("Release has no assets")
    const urls = new Map<string, string>()
    for (const name of [...names, "SHA256SUMS"]) {
      const matching = assets.map(object).filter(asset => asset.name === name)
      const url = `https://github.com/stacx-lab/kinex/releases/download/v${version}/${name}`
      if (matching.length !== 1 || matching[0]?.browser_download_url !== url) throw new Error(`Missing or invalid release asset: ${name}`)
      urls.set(name, url)
    }
    const sums = await (await download(urls.get("SHA256SUMS")!)).text()
    const checksums = new Map<string, string>()
    for (const line of sums.trim().split(/\r?\n/)) {
      const match = /^([a-fA-F0-9]{64})  (\S+)$/.exec(line)
      if (!match || checksums.has(match[2]!)) throw new Error("Invalid release SHA256SUMS")
      checksums.set(match[2]!, match[1]!.toLowerCase())
    }
    report(`Downloading Kinex ${version} (standalone, core and setup)...`)
    // Verify every artifact before touching the installation or persistent cache.
    const archives: { name: string; bytes: Buffer }[] = []
    for (const name of names) {
      if (!checksums.has(name)) throw new Error(`Missing checksum: ${name}`)
      const bytes = Buffer.from(await (await download(urls.get(name)!)).arrayBuffer())
      if (createHash("sha256").update(bytes).digest("hex") !== checksums.get(name)) throw new Error(`Checksum mismatch: ${name}`)
      archives.push({ name, bytes })
    }
    const cache = path.join(options.dataDir ?? paths().data, "releases", version)
    await mkdir(cache, { recursive: true })
    for (const { name, bytes } of archives) {
      const file = path.join(cache, name)
      const temporary = `${file}.${process.pid}.tmp`
      try { await writeFile(temporary, bytes); await rename(temporary, file) }
      finally { await rm(temporary, { force: true }) }
    }
    const args = ["install", ...installed.args, "--ignore-scripts", "--no-audit", "--no-fund", ...names.map(name => path.join(cache, name))]
    try { await run("npm", args, cwd, true) }
    catch (error) {
      const quote = (arg: string) => `'${arg.replaceAll("'", "'\\''")}'`
      throw new Error(`Kinex upgrade failed; npm may have partially changed the installation. Retry: npm ${args.map(quote).join(" ")}\n${String(error)}`)
    }
    report(`Upgraded Kinex to ${version}. Restart running Kinex sessions. Release archives are retained in ${cache}.`)
  }
  if (options.all) {
    // Use the newly installed code and bundled SDK, even after replacing this process's files.
    await run(process.execPath, [path.join(installed.root, "bin", "kinex.mjs"), "update", "--extensions"], cwd, true)
  }
}

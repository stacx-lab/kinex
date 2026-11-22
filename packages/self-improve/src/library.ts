import { execFile } from "node:child_process"
import { cp, mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { ConfigPaths } from "@kinex/core/config/paths"
import { libRoots } from "@kinex/core/lib/catalog"
import { parseFrontmatter } from "@kinex/core/skill/index"
import { which } from "@kinex/core/util/process"
import { entries, librariesDir, parseLine, pythonDir, versionDir, writeJson } from "./layout.ts"

// A library is what a worker is given beyond plain Kinex. payload/ ships and
// uses Kinex's own folder names, so installing is a copy; memory/ is the
// distiller's and never ships. A published version L<n> is never edited, and
// the newest is the current one.
export const payloadDir = (library: string) => path.join(library, "payload")
export const memoryDir = (library: string) => path.join(library, "memory")
export const briefFile = (kinex: string) => path.join(kinex, "self-improve", "brief.md")
// The payload folders, each installed into the workspace's Kinex folder of the same
// name: skills, host tools, kinex.lib modules, and programs exec runs by file.
export const PARTS = ["skills", "tools", "lib", "programs"] as const
export type Part = typeof PARTS[number]

const exists = (target: string) => stat(target).then(() => true, () => false)
// Python's byte-code caches, left by code a distiller ran, are not part of a library.
const CACHE = "__pycache__"
const shipped = async (library: string, part: Part) => (await entries(path.join(payloadDir(library), part))).filter(name => name !== CACHE)

// Every session in a workspace with the library installed is given its brief,
// so a brief that ships stays as short as the distiller is asked to keep it.
export const briefLimit = { lines: 15, characters: 2000 }
const number = (version: string) => Number(version.slice(1))

export async function versions(root: string): Promise<string[]> {
  return (await entries(librariesDir(root))).filter(name => /^L\d+$/.test(name)).sort((a, b) => number(a) - number(b))
}

export async function newestVersion(root: string): Promise<string> {
  const newest = (await versions(root)).at(-1)
  if (!newest) throw new Error(`No library version in ${librariesDir(root)}`)
  return newest
}

async function write(root: string, source: string | undefined, manifest: { parent?: string; source?: string }): Promise<string> {
  const version = `L${(await versions(root)).reduce((highest, name) => Math.max(highest, number(name)), -1) + 1}`
  const staging = path.join(librariesDir(root), `.${version}-${process.pid}`)
  await rm(staging, { recursive: true, force: true })
  for (const part of PARTS) await mkdir(path.join(payloadDir(staging), part), { recursive: true })
  await mkdir(memoryDir(staging))
  if (source) for (const part of [payloadDir, memoryDir]) if (await exists(part(source))) await cp(part(source), part(staging), { recursive: true })
  await writeJson(path.join(staging, "manifest.json"), { version, ...manifest, createdAt: new Date().toISOString() })
  // The rename is the publication: trials opened afterwards use this version.
  await rename(staging, versionDir(root, version))
  return version
}

export const createLibrary = (root: string) => write(root, undefined, {})

// The Python a library's code is read with: the workers' own, which the first
// trial builds, else the host's. A host with neither has no worker to ship to.
async function python(): Promise<string | undefined> {
  for (const bin of [".pixi/envs/default/bin", ".venv/bin"]) if (await exists(path.join(pythonDir(), bin, "python3"))) return path.join(pythonDir(), bin, "python3")
  return which("python3")
}

// Parses each file and prints what it defines; nothing is imported or run. Names
// are gathered at any depth, and a star import from another module is reported,
// so that what cannot be known is not called missing.
const DEFINED = `
import ast, json, sys
out = {}
for file in sys.argv[1:]:
    try:
        tree = ast.parse(open(file, encoding="utf-8").read(), file)
    except SyntaxError as error:
        out[file] = {"error": "line %s: %s" % (error.lineno, error.msg)}
        continue
    names, star = set(), False
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(node.name)
        elif isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store):
            names.add(node.id)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            star = star or (isinstance(node, ast.ImportFrom) and node.level == 0 and any(alias.name == "*" for alias in node.names))
            names.update((alias.asname or alias.name).split(".")[0] for alias in node.names)
    out[file] = {"names": sorted(names), "star": star}
print(json.dumps(out))
`
interface Parsed { error?: string; names?: string[]; star?: boolean }

const sources = async (directory: string) => (await readdir(directory, { recursive: true }).catch(() => [])).filter(file => file.endsWith(".py") && !file.split(path.sep).includes(CACHE)).sort()
// What a mention of a file looks like, not of a function: kitchen.py, kitchen.md.
const SUFFIXES = new Set(["py", "md", "json", "jsonl", "txt", "yaml", "yml", "csv", "log", "png", "jpg", "sh"])

// rsi's gate on code: every Python file of lib/ and programs/ compiles, and a
// skill or the brief names nothing in a lib/ module that the module does not
// define, since a text that names a missing function costs every trial that
// follows it. A mention is <module>.<name>, with kinex.lib. or lib. before it or
// not; names of the module's own files are passed over, and the first name after
// them must be defined.
async function code(library: string): Promise<string[]> {
  const payload = payloadDir(library)
  const files = (await Promise.all((["lib", "programs"] as const).map(async part => (await sources(path.join(payload, part))).map(file => path.join(part, file))))).flat()
  const interpreter = files.length ? await python() : undefined
  if (!interpreter) return []
  const { stdout } = await promisify(execFile)(interpreter, ["-I", "-c", DEFINED, ...files], { cwd: payload, maxBuffer: 64 * 1024 * 1024 })
  const parsed = JSON.parse(stdout) as Record<string, Parsed>
  const problems = files.filter(file => parsed[file]?.error).map(file => `payload/${file}: does not compile: ${parsed[file]!.error}`)
  const texts = [...(await readdir(path.join(payload, "skills"), { recursive: true }).catch(() => [])).filter(file => path.basename(file) === "SKILL.md").sort().map(file => path.join("skills", file)), "brief.md"]
  for (const entry of await shipped(library, "lib")) {
    const module = entry.replace(/\.py$/, "")
    const own = files.filter(file => file === path.join("lib", entry) || file.startsWith(path.join("lib", entry) + path.sep))
    // A file that does not compile or takes names from elsewhere leaves what the module defines unknown.
    if (module.startsWith("_") || !own.length || own.some(file => parsed[file]?.error || parsed[file]?.star)) continue
    const defined = new Set(own.flatMap(file => parsed[file]?.names ?? []))
    const inner = new Set(own.flatMap(file => file.replace(/\.py$/, "").split(path.sep).slice(2)))
    const mention = new RegExp(`(?<![\\w./-])(?:kinex\\.lib\\.|lib\\.)?${module}((?:\\.[A-Za-z_]\\w*)+)`, "g")
    for (const file of texts) {
      const text = await readFile(path.join(payload, file), "utf8").catch(() => "")
      const missing = new Set<string>()
      for (const [, chain = ""] of text.matchAll(mention)) {
        const name = chain.slice(1).split(".").find(part => !inner.has(part))
        if (name && !defined.has(name) && !SUFFIXES.has(name)) missing.add(name)
      }
      for (const name of [...missing].sort()) problems.push(`payload/${file}: names ${module}.${name}, which payload/lib/${entry} does not define`)
    }
  }
  return problems
}

// The analysts' rows are counted by the distiller's own code every session: a line that is not a JSON object breaks the count.
async function rows(library: string): Promise<string[]> {
  const problems: string[] = []
  const directory = path.join(memoryDir(library), "rows")
  for (const name of (await entries(directory)).filter(name => name.endsWith(".jsonl"))) {
    const lines = (await readFile(path.join(directory, name), "utf8")).split("\n")
    const bad = lines.findIndex(line => { const value = line.trim() ? parseLine(line) : {}; return typeof value !== "object" || value === null || Array.isArray(value) })
    if (bad >= 0) problems.push(`memory/rows/${name}:${bad + 1}: not a JSON object`)
  }
  return problems
}

/** Problems that would keep the candidate from loading as Kinex content, break Kinex's own, or cost the trials that ship it; none means it may ship. */
export async function check(library: string): Promise<string[]> {
  const problems: string[] = []
  const skills = path.join(payloadDir(library), "skills")
  const tools = path.join(payloadDir(library), "tools")
  const names = new Set<string>()
  const claim = (name: string, file: string) => {
    if (names.has(name)) problems.push(`${file}: duplicate skill name "${name}"`)
    names.add(name)
  }
  for (const entry of (await readdir(skills, { recursive: true }).catch(() => [])).sort()) {
    if (path.basename(entry) !== "SKILL.md") continue
    const file = path.join("payload/skills", entry)
    const { meta } = parseFrontmatter(await readFile(path.join(skills, entry), "utf8"))
    if (!meta["name"] || !meta["description"]) problems.push(`${file}: frontmatter needs name and description`)
    else claim(meta["name"], file)
  }
  for (const name of await entries(skills)) {
    const directory = path.join(skills, name)
    if ((await stat(directory)).isDirectory() && !(await exists(path.join(directory, "SKILL.md")))) problems.push(`payload/skills/${name}: no SKILL.md`)
  }
  // Kinex loads a tool only from a .ts or .js file directly in tools/: anything else there would ship and never load.
  for (const name of await entries(tools))
    if (!/\.(ts|js)$/.test(name) || !(await stat(path.join(tools, name))).isFile())
      problems.push(`payload/tools/${name}: Kinex loads only .ts and .js files in tools/; put Python code in a kinex.lib module`)
  // A workspace module replaces the builtin kinex.lib module of the same name, in every worker:
  // one of core's own, or one a package composed with it adds, as setup adds calibration.
  const shippedRoots = (await libRoots(library)).filter(root => root.origin === "builtin")
  const builtins = new Set((await Promise.all(shippedRoots.map(root => entries(root.directory)))).flat().map(name => name.replace(/\.py$/, "")))
  for (const name of await shipped(library, "lib"))
    if (!name.startsWith("_") && builtins.has(name.replace(/\.py$/, "")))
      problems.push(`payload/lib/${name}: replaces the builtin kinex.lib module of the same name for every worker; rename it`)
  const brief = (await readFile(path.join(payloadDir(library), "brief.md"), "utf8").catch(() => "")).trim()
  const lines = brief ? brief.split(/\r?\n/).length : 0
  if (lines > briefLimit.lines || brief.length > briefLimit.characters)
    problems.push(`payload/brief.md: ${lines} lines and ${brief.length} characters, at most ${briefLimit.lines} lines and ${briefLimit.characters} characters`)
  return [...problems, ...await code(library), ...await rows(library)]
}

/** Candidate to version: nothing is published unless the check passes. */
export async function publish(root: string, candidate: string, manifest: { parent: string; source: string }) {
  const problems = await check(candidate)
  return problems.length ? { problems } : { problems, version: await write(root, candidate, manifest) }
}

/**
 * Version to workspace: each payload part goes where Kinex discovers it and the
 * brief where this package's context gives it to every session. Trial
 * workspaces and /self-improve install use this same copy, so a worker sees a
 * library exactly as a user who installed it. Nothing existing is overwritten.
 */
export async function install(library: string, workspace: string): Promise<Record<Part, string[]>> {
  const kinex = await ConfigPaths.projectDir(workspace)
  const installed = Object.fromEntries(await Promise.all(PARTS.map(async part => [part, await shipped(library, part)]))) as Record<Part, string[]>
  const copies = PARTS.flatMap(part => installed[part].map(name =>
    ({ from: path.join(payloadDir(library), part, name), to: path.join(kinex, part, name) })))
  const taken = (await Promise.all(copies.map(async copy => await exists(copy.to) ? copy.to : undefined))).filter(target => target !== undefined)
  if (taken.length) throw new Error(`Already present, remove or rename before installing:\n${taken.join("\n")}`)
  for (const copy of copies) await cp(copy.from, copy.to, { recursive: true, filter: source => path.basename(source) !== CACHE })
  const brief = path.join(payloadDir(library), "brief.md")
  if (await exists(brief)) await cp(brief, briefFile(kinex))
  return installed
}

export async function installedBrief(workspace: string): Promise<string> {
  return (await readFile(briefFile(await ConfigPaths.projectDir(workspace)), "utf8").catch(() => "")).trim()
}

import path from "node:path"
import { readFile, readdir, stat } from "node:fs/promises"
import { z } from "zod"
import { ConfigPaths } from "../config/paths.ts"
import { Global } from "../global.ts"
import { Assets } from "../installation/assets.ts"
import { currentScope } from "../scope.ts"
import { scanPython } from "./python.ts"

// The function library is the kinex.lib package: builtin modules, those contributed
// packages add, and the lib/ directory of every workspace and the global configuration.
// Its tree is what Python's import system resolves, read from source without starting Python.
export const LibPath = z.string().regex(/^(?:[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)?$/, "a dotted module or function path")
const Origin = z.enum(["workspace", "global", "builtin"])
export const LibModule = z.strictObject({
  kind: z.literal("module"),
  path: LibPath,
  file: z.string().nullable().describe("the module's source; null for a directory without __init__.py"),
  origin: Origin.nullable(),
  doc: z.string().describe("the module docstring: what it contains and its conventions"),
  modules: z.array(z.strictObject({ name: z.string(), origin: Origin.nullable(), summary: z.string() })),
  functions: z.array(z.string()).describe("public functions this module defines"),
})
export const LibFunction = z.strictObject({
  kind: z.literal("function"),
  path: LibPath,
  file: z.string(),
  line: z.number().int(),
  signature: z.string().describe("the def header as written"),
  doc: z.string(),
})
export const LibNode = z.strictObject({
  node: z.discriminatedUnion("kind", [LibModule, LibFunction]),
  problems: z.array(z.string()),
})
export type LibNode = z.infer<typeof LibNode>
type Origin = z.infer<typeof Origin>

interface Root { directory: string; origin: Origin }
// Where a module's source is and where its submodules are searched.
interface Location { file?: string; origin?: Origin; search: Root[] }

const IDENTIFIER = /^[A-Za-z_]\w*$/
const isFile = (target: string) => stat(target).then(found => found.isFile(), () => false)
const entries = (directory: string) => readdir(directory, { withFileTypes: true }).catch(() => [])

/** Search roots of kinex.lib, nearest workspace first and the shipped package last. */
export async function libRoots(cwd: string): Promise<Root[]> {
  const configured = (await ConfigPaths.directories(cwd)).toReversed()
  return [
    ...configured.map(directory => ({ directory: path.join(directory, "lib"), origin: directory === Global.Path.config ? "global" as const : "workspace" as const })),
    ...(currentScope().builtinLibRoots ?? []).map(directory => ({ directory, origin: "builtin" as const })),
    { directory: Assets.python("kinex", "lib"), origin: "builtin" },
  ]
}

// Python's path finder: in each root a package beats a module, the first root with either
// wins, and directories without __init__.py merge across roots only when nothing else matched.
async function find(name: string, search: Root[]): Promise<Location | undefined> {
  const portions: Root[] = []
  for (const { directory, origin } of search) {
    const target = path.join(directory, name)
    if (await isFile(path.join(target, "__init__.py"))) return { file: path.join(target, "__init__.py"), origin, search: [{ directory: target, origin }] }
    if (await isFile(`${target}.py`)) return { file: `${target}.py`, origin, search: [] }
    if ((await entries(target)).some(entry => entry.isDirectory() || entry.name.endsWith(".py"))) portions.push({ directory: target, origin })
  }
  return portions.length ? { search: portions } : undefined
}

async function source(location: Location) {
  return location.file ? scanPython(await readFile(location.file, "utf8")) : { doc: "", functions: [] }
}

async function submodules(location: Location, problems: string[]) {
  const names = new Set<string>()
  for (const { directory } of location.search) for (const entry of await entries(directory)) {
    const name = entry.isDirectory() ? entry.name : entry.name.endsWith(".py") ? entry.name.slice(0, -3) : undefined
    if (name === undefined || name.startsWith("_") || name.startsWith(".")) continue
    if (IDENTIFIER.test(name)) names.add(name)
    else if (!entry.isDirectory()) problems.push(`${path.join(directory, entry.name)}: not importable, its name is not a Python identifier`)
  }
  const found = await Promise.all([...names].sort().map(async name => ({ name, location: await find(name, location.search) })))
  return Promise.all(found.flatMap(({ name, location }) => location ? [(async () => ({
    name, origin: location.origin ?? null, summary: (await source(location)).doc.split("\n")[0]!,
  }))()] : []))
}

/** The module or function at a dotted path; "" is the library itself. */
export async function libNode(cwd: string, target = ""): Promise<LibNode> {
  const roots = await libRoots(cwd)
  const builtin = roots.at(-1)!
  let location: Location = { file: path.join(builtin.directory, "__init__.py"), origin: builtin.origin, search: roots }
  const segments = target ? target.split(".") : []
  for (const [index, name] of segments.entries()) {
    const child = name.startsWith("_") ? undefined : await find(name, location.search)
    if (child) { location = child; continue }
    const found = index === segments.length - 1 ? (await source(location)).functions.find(item => item.name === name) : undefined
    const parent = segments.slice(0, index).join(".")
    if (!found) throw new Error(`kinex.lib has no module or function ${target}: ${parent || "the library"} has no ${name}`)
    return { node: { kind: "function", path: target, file: location.file!, line: found.line, signature: found.signature, doc: found.doc }, problems: [] }
  }
  const problems: string[] = []
  const [{ doc, functions }, modules] = await Promise.all([source(location), submodules(location, problems)])
  for (const { name } of modules) if (functions.some(item => item.name === name))
    problems.push(`${target ? `${target}.` : ""}${name} is both a module and a function of ${location.file}; the module wins`)
  return {
    node: { kind: "module", path: target, file: location.file ?? null, origin: location.origin ?? null, doc, modules, functions: functions.map(item => item.name) },
    problems: problems.sort(),
  }
}

/** The library's top-level modules, one per line, for the agent's context. */
export async function formatLib(cwd: string): Promise<string> {
  const { node } = await libNode(cwd)
  if (node.kind !== "module") return ""
  return ["<lib>", "Functions in kinex.lib by module; read a module or function with the lib tool.",
    ...node.modules.map(module => `  - ${module.name} (${module.origin ?? "directory"}): ${module.summary}`), "</lib>"].join("\n")
}

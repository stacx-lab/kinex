import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { parse as parseYaml } from "yaml"
import { parseFrontmatter } from "@kinex/core/skill/index"
import { entries } from "./layout.ts"
import { PARTS, payloadDir } from "./library.ts"

// What a worker leaves in the folders it keeps things in, for the distiller:
// learned/ holds the final copy of every kept file that is not the library as
// shipped, and learned.md lists them by resource: new, changed, or as shipped.
// The folders are Kinex's own: library code, saved programs, skills, tools, and notes.
const FOLDERS: Record<string, string> = { lib: "Code", programs: "Programs", skills: "Skills", tools: "Tools", memos: "Notes" }
// The parts of a library that are installed as files, into the folder of the same name.
const INSTALLED: readonly string[] = PARTS
const SKIPPED = new Set(["__pycache__", ".venv", "node_modules", ".git"])
const MAX_BYTES = 20 * 1024 * 1024

type Status = "shipped" | "changed" | "new"
interface Kept { file: string; resource: string; folder: string; bytes: number; status: Status; extracted?: string }

const exists = (target: string) => stat(target).then(() => true, () => false)
const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`
const short = (text: string, max: number) => text.length > max ? `${text.slice(0, max)}…` : text
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim()

// Regular files under a directory, relative to it: no links, caches or environments, nothing huge.
async function files(directory: string, inside = ""): Promise<string[]> {
  const found: string[] = []
  const listed = await readdir(path.join(directory, inside), { withFileTypes: true }).catch(() => [])
  for (const entry of listed.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = path.join(inside, entry.name)
    if (entry.isDirectory()) { if (!SKIPPED.has(entry.name)) found.push(...await files(directory, relative)) }
    else if (entry.isFile() && !entry.name.endsWith(".pyc") && (await stat(path.join(directory, relative))).size <= MAX_BYTES) found.push(relative)
  }
  return found
}

// What a skill or a tool says it is, or how a file begins.
async function describe(resource: string, folder: string): Promise<string> {
  const read = (file: string) => readFile(file, "utf8").catch(() => undefined)
  if (folder === "skills") return short(oneLine(parseFrontmatter(await read(path.join(resource, "SKILL.md")) ?? "").meta["description"] ?? ""), 240)
  if (folder === "tools") {
    try {
      const manifest = parseYaml(await read(path.join(resource, "tool.yaml")) ?? "") as { description?: unknown } | null
      return typeof manifest?.description === "string" ? short(oneLine(manifest.description), 240) : ""
    } catch { return "" }
  }
  const first = (await stat(resource)).isFile()
    ? (await read(resource))?.split("\n").filter(line => !line.startsWith("#!")).map(line => line.replace(/^(#+|"""|'''|\/\/)\s*/, "").replace(/\s*("""|''')$/, "").trim()).find(Boolean)
    : undefined
  return first ? `begins: ${short(first, 200)}` : ""
}

/**
 * Copies what the worker kept beyond the library version it was shipped into
 * `<record>/learned/` and writes `<record>/learned.md`; returns the copied files,
 * relative to the workspace.
 */
export async function keep(workspace: string, library: string, record: string): Promise<string[]> {
  // The workspace's own Kinex folder: a trial that never started has none, and an ancestor's is not its.
  const kinex = path.join(workspace, ".kinex")
  const payload = payloadDir(library)
  const named = (...parts: string[]) => path.join(path.relative(workspace, kinex), ...parts)
  // A library made before payloads had lib/ shipped its code as a skill's body,
  // which its brief had the worker extract: such a file is the library's, not the worker's.
  const skills = await Promise.all((await entries(path.join(payload, "skills"))).map(async name =>
    ({ name, text: await readFile(path.join(payload, "skills", name, "SKILL.md"), "utf8").catch(() => "") })))
  const kept: Kept[] = []
  for (const folder of Object.keys(FOLDERS)) {
    for (const inside of await files(path.join(kinex, folder))) {
      const content = await readFile(path.join(kinex, folder, inside))
      const shipped = INSTALLED.includes(folder) ? await readFile(path.join(payload, folder, inside)).catch(() => undefined) : undefined
      const body = folder === "lib" ? content.toString("utf8").trim() : ""
      const extracted = body ? skills.find(skill => skill.text.includes(body))?.name : undefined
      kept.push({ file: named(folder, inside), resource: named(folder, inside.split(path.sep)[0]!), folder, bytes: content.length,
        status: shipped ? (shipped.equals(content) ? "shipped" : "changed") : extracted ? "shipped" : "new", ...(extracted ? { extracted } : {}) })
    }
  }
  const removed: string[] = []
  for (const folder of INSTALLED) for (const inside of await files(path.join(payload, folder))) if (!(await exists(path.join(kinex, folder, inside)))) removed.push(named(folder, inside))
  const copied = kept.filter(item => item.status !== "shipped").map(item => item.file)
  for (const file of copied) {
    await mkdir(path.dirname(path.join(record, "learned", file)), { recursive: true })
    await copyFile(path.join(workspace, file), path.join(record, "learned", file))
  }

  const sections = new Map<string, string[]>()
  const unchanged: string[] = []
  for (const resource of [...new Set(kept.map(item => item.resource))]) {
    const own = kept.filter(item => item.resource === resource)
    const folder = own[0]!.folder
    const extracted = own.find(item => item.extracted)?.extracted
    if (own.every(item => item.status === "shipped")) { unchanged.push(extracted ? `${resource} (extracted unchanged from the skill ${extracted})` : resource); continue }
    const against = own.every(item => item.status === "new") ? "new (not in the library)" : "changed from the library as shipped"
    const directory = (await stat(path.join(workspace, resource))).isDirectory()
    const description = await describe(path.join(workspace, resource), folder)
    const title = FOLDERS[folder]!
    sections.set(title, [...sections.get(title) ?? [], `- ${resource}: ${against}, ${size(own.reduce((sum, item) => sum + item.bytes, 0))} — learned/${resource}${directory ? "/" : ""}${description ? `\n  ${description}` : ""}`])
  }
  await writeFile(path.join(record, "learned.md"), [
    "# What the sub-agent kept", "",
    `What the sub-agent left in the folders it keeps things in (${Object.keys(FOLDERS).map(folder => `${named(folder)}/`).join(", ")}) that is not library ${path.basename(library)} as shipped. The final copies are under learned/ (learned/<path>).`,
    ...[...sections].flatMap(([title, items]) => ["", `## ${title}`, ...items]),
    ...(sections.size ? [] : ["", "Nothing beyond the library as shipped."]),
    ...(unchanged.length || removed.length ? ["", "## The library as shipped",
      ...(unchanged.length ? [`- unchanged: ${unchanged.join(", ")}`] : []),
      ...(removed.length ? [`- library files the sub-agent removed: ${short(removed.join(", "), 1200)}`] : [])] : []),
  ].join("\n") + "\n")
  return copied
}

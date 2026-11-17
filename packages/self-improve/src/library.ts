import { cp, mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises"
import path from "node:path"
import { parse as parseYaml } from "yaml"
import { ConfigPaths } from "@kinex/core/config/paths"
import { parseFrontmatter } from "@kinex/core/skill/index"
import { ToolManifest } from "@kinex/core/tool/python-catalog"
import { entries, librariesDir, versionDir, writeJson } from "./layout.ts"

// A library is what a worker is given beyond plain Kinex. payload/ ships and
// uses Kinex's own folder names, so installing is a copy; memory/ is the
// distiller's and never ships. A published version L<n> is never edited, and
// the newest is the current one.
export const payloadDir = (library: string) => path.join(library, "payload")
export const memoryDir = (library: string) => path.join(library, "memory")
export const briefFile = (kinex: string) => path.join(kinex, "self-improve", "brief.md")

const exists = (target: string) => stat(target).then(() => true, () => false)

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
  for (const part of ["skills", "tools"]) await mkdir(path.join(payloadDir(staging), part), { recursive: true })
  await mkdir(memoryDir(staging))
  if (source) for (const part of [payloadDir, memoryDir]) if (await exists(part(source))) await cp(part(source), part(staging), { recursive: true })
  await writeJson(path.join(staging, "manifest.json"), { version, ...manifest, createdAt: new Date().toISOString() })
  // The rename is the publication: trials opened afterwards use this version.
  await rename(staging, versionDir(root, version))
  return version
}

export const createLibrary = (root: string) => write(root, undefined, {})

/** Problems that would keep Kinex from loading the candidate's skills and tools; none means it may ship. */
export async function check(library: string): Promise<string[]> {
  const problems: string[] = []
  const skills = path.join(payloadDir(library), "skills")
  const tools = path.join(payloadDir(library), "tools")
  const names = { skill: new Set<string>(), tool: new Set<string>() }
  const claim = (kind: "skill" | "tool", name: string, file: string) => {
    if (names[kind].has(name)) problems.push(`${file}: duplicate ${kind} name "${name}"`)
    names[kind].add(name)
  }
  for (const entry of (await readdir(skills, { recursive: true }).catch(() => [])).sort()) {
    if (path.basename(entry) !== "SKILL.md") continue
    const file = path.join("payload/skills", entry)
    const { meta } = parseFrontmatter(await readFile(path.join(skills, entry), "utf8"))
    if (!meta["name"] || !meta["description"]) problems.push(`${file}: frontmatter needs name and description`)
    else claim("skill", meta["name"], file)
  }
  for (const name of await entries(skills)) {
    const directory = path.join(skills, name)
    if ((await stat(directory)).isDirectory() && !(await exists(path.join(directory, "SKILL.md")))) problems.push(`payload/skills/${name}: no SKILL.md`)
  }
  for (const name of await entries(tools)) {
    const directory = path.join(tools, name)
    if (!(await stat(directory)).isDirectory()) continue
    const file = `payload/tools/${name}/tool.yaml`
    const text = await readFile(path.join(directory, "tool.yaml"), "utf8").catch(() => undefined)
    if (text === undefined) { problems.push(`${file}: missing`); continue }
    const raw = (() => { try { return parseYaml(text) as unknown } catch (error) { return error instanceof Error ? error : new Error(String(error)) } })()
    if (raw instanceof Error) { problems.push(`${file}: ${raw.message}`); continue }
    const manifest = ToolManifest.safeParse(raw)
    if (!manifest.success) { problems.push(`${file}: ${manifest.error.issues.map(issue => `${issue.path.join(".") || "manifest"}: ${issue.message}`).join("; ")}`); continue }
    claim("tool", manifest.data.name, file)
    if (!(await exists(path.join(directory, manifest.data.entry)))) problems.push(`${file}: entry ${manifest.data.entry} does not exist`)
  }
  const brief = (await readFile(path.join(payloadDir(library), "brief.md"), "utf8").catch(() => "")).trim()
  const lines = brief ? brief.split(/\r?\n/).length : 0
  if (lines > briefLimit.lines || brief.length > briefLimit.characters)
    problems.push(`payload/brief.md: ${lines} lines and ${brief.length} characters, at most ${briefLimit.lines} lines and ${briefLimit.characters} characters`)
  return problems
}

/** Candidate to version: nothing is published unless the check passes. */
export async function publish(root: string, candidate: string, manifest: { parent: string; source: string }) {
  const problems = await check(candidate)
  return problems.length ? { problems } : { problems, version: await write(root, candidate, manifest) }
}

/**
 * Version to workspace: its skills and tools go where Kinex discovers them and
 * its brief where this package's context gives it to every session. Trial
 * workspaces and /self-improve install use this same copy, so a worker sees a
 * library exactly as a user who installed it. Nothing existing is overwritten.
 */
export async function install(library: string, workspace: string): Promise<{ skills: string[]; tools: string[] }> {
  const kinex = await ConfigPaths.projectDir(workspace)
  const installed = { skills: await entries(path.join(payloadDir(library), "skills")), tools: await entries(path.join(payloadDir(library), "tools")) }
  const copies = (["skills", "tools"] as const).flatMap(part => installed[part].map(name =>
    ({ from: path.join(payloadDir(library), part, name), to: path.join(kinex, part, name) })))
  const taken = (await Promise.all(copies.map(async copy => await exists(copy.to) ? copy.to : undefined))).filter(target => target !== undefined)
  if (taken.length) throw new Error(`Already present, remove or rename before installing:\n${taken.join("\n")}`)
  for (const copy of copies) await cp(copy.from, copy.to, { recursive: true })
  const brief = path.join(payloadDir(library), "brief.md")
  if (await exists(brief)) await cp(brief, briefFile(kinex))
  return installed
}

export async function installedBrief(workspace: string): Promise<string> {
  return (await readFile(briefFile(await ConfigPaths.projectDir(workspace)), "utf8").catch(() => "")).trim()
}

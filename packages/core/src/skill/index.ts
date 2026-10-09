import { readFile } from "node:fs/promises"
import { glob } from "tinyglobby"
import path from "node:path"
import { contentRoots } from "../config/content.ts"
import { currentScope } from "../scope.ts"
import { Assets } from "../installation/assets.ts"
import { exists } from "../util/filesystem.ts"
import { parseXMLSkill } from "./xml.ts"

export interface SkillInfo {
  name: string
  description: string
  file: string
  directory: string
  format?: "xml"
  tool?: string
  // Calibration skills: comma-separated selectors this skill can resolve —
  // exact readiness item ids (intrinsics:wrist_cam) or <section>:<device type>
  // patterns (intrinsics:rgb). Surfaced in <available_skills> so setup workflows
  // can match requests without loading every skill.
  resolves?: string
  // Same selector grammar, opposite direction: calibration items that must be
  // DONE before this skill is usable. Advisory — the skill tool warns about
  // unmet items instead of refusing.
  requires?: string
}

// Built-in skills ship with the package at builtin/skill/ (the same shipping
// model as builtin/tool/), scanned LAST so a robot-specific or project copy of
// the same name overrides the shipped one (listSkills is first-seen-wins over
// the contentRoots order).
const builtinDir = () => Assets.builtin("skill")

export async function skillRoots(cwd: string): Promise<string[]> {
  return [...await contentRoots(cwd, "skill", builtinDir()), ...(currentScope().builtinSkillRoots ?? [])]
}

// Minimal frontmatter parser: --- delimited key: value block at the top of the file.
export function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?/)
  if (!match) return { meta: {}, body: text }
  const meta: Record<string, string> = {}
  for (const line of match[1]!.split("\n")) {
    const colon = line.indexOf(":")
    if (colon === -1) continue
    meta[line.slice(0, colon).trim()] = line.slice(colon + 1).trim()
  }
  return { meta, body: text.slice(match[0].length) }
}

export async function discoverSkills(cwd: string): Promise<{ skills: SkillInfo[]; problems: string[] }> {
  const skills: SkillInfo[] = []
  const problems: string[] = []
  const seen = new Set<string>()
  const xmlBundles = new Set<string>()
  for (const skillDir of await skillRoots(cwd)) {
    if (!(await exists(skillDir))) continue
    const pattern = "**/SKILL.{xml,md}"
    for (const entry of (await glob(pattern, { cwd: skillDir, dot: true })).sort()) {
      const file = path.join(skillDir, entry)
      const xml = entry.endsWith(".xml")
      const bundle = path.dirname(entry)
      if (xmlBundles.has(bundle)) continue
      // A local XML file shadows the same bundle even when it cannot be parsed.
      if (xml) xmlBundles.add(bundle)
      if (!xml && await exists(path.join(path.dirname(file), "SKILL.xml"))) continue
      let meta: Record<string, string>
      try {
        const text = await readFile(file, "utf8")
        meta = xml ? parseXMLSkill(text) : parseFrontmatter(text).meta
      } catch (error) {
        problems.push(`${file}: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      const name = meta["name"] ?? path.basename(path.dirname(file))
      if (seen.has(name)) continue
      seen.add(name)
      skills.push({
        name,
        description: meta["description"] ?? "",
        file,
        directory: path.dirname(file),
        ...(xml ? { format: "xml" as const, tool: meta["tool"] } : {}),
        ...(meta["resolves"] ? { resolves: meta["resolves"] } : {}),
        ...(meta["requires"] ? { requires: meta["requires"] } : {}),
      })
    }
  }
  return { skills: skills.sort((a, b) => a.name.localeCompare(b.name)), problems }
}

export async function listSkills(cwd: string): Promise<SkillInfo[]> {
  return (await discoverSkills(cwd)).skills
}

export async function loadSkill(cwd: string, name: string): Promise<{ info: SkillInfo; content: string } | undefined> {
  const skills = await listSkills(cwd)
  const info = skills.find((skill) => skill.name === name)
  if (!info) return undefined
  const text = await readFile(info.file, "utf8")
  return { info, content: info.format === "xml" ? text : parseFrontmatter(text).body }
}

export function formatSkills(skills: SkillInfo[], problems: string[] = []): string {
  const lines = skills.map(
    (skill) =>
      `  - ${skill.name}: ${skill.description}${skill.tool ? ` [tool: ${skill.tool}]` : ""}${skill.resolves ? ` [resolves: ${skill.resolves}]` : ""}${skill.requires ? ` [requires: ${skill.requires}]` : ""}`,
  )
  return [
    "<available_skills>", "Load a skill with the skill tool when its description matches the task.",
    ...lines, "</available_skills>",
    ...(problems.length ? ["<skill_problems>", ...problems, "</skill_problems>"] : []),
  ].join("\n")
}

import { readFile } from "node:fs/promises"
import { glob } from "tinyglobby"
import path from "node:path"
import { contentRoots } from "../config/content.ts"
import { currentScope } from "../scope.ts"
import { Assets } from "../installation/assets.ts"
import { exists } from "../util/filesystem.ts"

export interface SkillInfo {
  name: string
  description: string
  file: string
  directory: string
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

export async function listSkills(cwd: string): Promise<SkillInfo[]> {
  const skills: SkillInfo[] = []
  const seen = new Set<string>()
  for (const skillDir of [...await contentRoots(cwd, "skill", builtinDir()), ...(currentScope().builtinSkillRoots ?? [])]) {
    if (!(await exists(skillDir))) continue
    const pattern = "**/SKILL.md"
    for (const entry of (await glob(pattern, { cwd: skillDir, dot: true })).sort()) {
      const file = path.join(skillDir, entry)
      const { meta } = parseFrontmatter(await readFile(file, "utf8"))
      const name = meta["name"] ?? path.basename(path.dirname(file))
      if (seen.has(name)) continue
      seen.add(name)
      skills.push({
        name,
        description: meta["description"] ?? "",
        file,
        directory: path.dirname(file),
        ...(meta["resolves"] ? { resolves: meta["resolves"] } : {}),
        ...(meta["requires"] ? { requires: meta["requires"] } : {}),
      })
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

export async function loadSkill(cwd: string, name: string): Promise<{ info: SkillInfo; content: string } | undefined> {
  const skills = await listSkills(cwd)
  const info = skills.find((skill) => skill.name === name)
  if (!info) return undefined
  const { body } = parseFrontmatter(await readFile(info.file, "utf8"))
  return { info, content: body }
}

export function formatSkills(skills: SkillInfo[]): string {
  const lines = skills.map(
    (skill) =>
      `  - ${skill.name}: ${skill.description}${skill.resolves ? ` [resolves: ${skill.resolves}]` : ""}${skill.requires ? ` [requires: ${skill.requires}]` : ""}`,
  )
  return ["<available_skills>", "Load a skill with the skill tool when its description matches the task.", ...lines, "</available_skills>"].join(
    "\n",
  )
}

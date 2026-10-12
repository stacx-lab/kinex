import path from "node:path"
import { createJiti } from "jiti"
import { glob } from "tinyglobby"
import { z } from "zod"
import { define, type Def } from "./tool.ts"
import { pythonTools } from "./python.ts"
import { toolRoots } from "./python-catalog.ts"
import { exists } from "../util/filesystem.ts"
import { DeviceTools } from "./device/index.ts"
import { SkillTool } from "./skill.ts"
import { RecordTool } from "./record.ts"
import { ProfileWriteTool } from "./profile_write.ts"
import { ExecTool } from "./exec.ts"

// Zero-install custom tools: any .ts/.js file in tools/ under a content root
// exporting {description, parameters (zod), execute}. Named <file> for default export,
// <file>_<export> otherwise. Disable module and disk caches so edits reload.
async function customTools(cwd: string): Promise<{ tools: Def[]; problems: string[] }> {
  const tools: Def[] = []
  const problems: string[] = []
  for (const dir of await toolRoots(cwd)) {
    if (!(await exists(dir))) continue
    const pattern = "*.{ts,js}"
    for (const entry of (await glob(pattern, { cwd: dir })).sort()) {
      const file = path.join(dir, entry)
      const base = path.basename(entry).replace(/\.(ts|js)$/, "")
      const mod = await createJiti(import.meta.url, { moduleCache: false, fsCache: false }).import(file).catch((error: unknown) => {
        problems.push(`${file}: ${error instanceof Error ? error.message : String(error)}`)
        return undefined
      })
      if (!mod) continue
      for (const [name, value] of Object.entries(mod as Record<string, unknown>)) {
        const candidate = value as Partial<Def> & { parameters?: unknown }
        if (typeof candidate?.execute !== "function" || typeof candidate?.description !== "string") continue
        const id = name === "default" ? base : `${base}_${name}`
        const parameters = (candidate.parameters ?? z.object({})) as z.ZodType
        tools.push(define(id, { description: candidate.description, parameters, execute: candidate.execute.bind(candidate) }))
      }
    }
  }
  return { tools, problems: problems.sort() }
}

export interface Loaded {
  tools: Map<string, Def>
  problems: string[]
}

// Rescanned every loop step: a tool written mid-task is callable at the next
// step. Discovered tools are sorted so the schema list is byte-stable (prompt
// cache) unless the set actually changed.
export interface ToolOptions { additionalTools?: Def[]; enableRecording?: boolean; reservedToolNames?: readonly string[] }
export async function loadTools(cwd: string, options: ToolOptions = {}): Promise<Loaded> {
  const builtins: Def[] = [...(options.additionalTools ?? []), SkillTool, ...DeviceTools, RecordTool, ProfileWriteTool, ExecTool]
  const [custom, python] = await Promise.all([customTools(cwd), pythonTools(cwd)])
  const discovered = [...custom.tools, ...python.tools].sort((a, b) => a.id.localeCompare(b.id))
  const tools = new Map<string, Def>()
  const problems = [...custom.problems, ...python.problems]
  for (const tool of [...builtins, ...discovered]) {
    if (tools.has(tool.id) || options.reservedToolNames?.includes(tool.id)) {
      problems.push(`duplicate tool id "${tool.id}" — keeping the first`)
      continue
    }
    tools.set(tool.id, tool)
  }
  if (!options.enableRecording) tools.delete("record")
  return { tools, problems: problems.sort() }
}

export function toModelSchema(def: Def): { name: string; description: string; inputSchema: Record<string, unknown> } {
  return {
    name: def.id,
    description: def.description,
    inputSchema: def.jsonSchema ?? z.toJSONSchema(def.parameters, { io: "input" }),
  }
}

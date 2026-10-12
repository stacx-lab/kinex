import { readFile } from "node:fs/promises"
import { parse as parseYaml } from "yaml"
import { glob } from "tinyglobby"
import path from "node:path"
import { z } from "zod"
import { DeviceType } from "../device/profile/schema.ts"
import { contentRoots } from "../config/content.ts"
import { Assets } from "../installation/assets.ts"
import { exists } from "../util/filesystem.ts"
import { deviceInputSchema } from "./device-input.ts"

// Python-defined tools: pieces of function whose execution involves NO agent.
// Two kinds, capability-enforced by the runner's dialog dispatcher:
//   perception  — read device output and parse it into a specific format
//                 (may read devices / profile / robot / call other perception tools)
//   controller  — execute a loop of actions until a termination condition
//                 (additionally may command devices and call any tool)
// One DIRECTORY per tool: <root>/tools/<name>/{tool.yaml,tool.py}, discovered
// like skills (contentRoots: robot → project → global → builtin/tool/),
// first-seen-wins by manifest name. The agent sees each as a first-class tool; the yaml's
// `parameters` (raw JSON Schema) is sent verbatim as the input schema.
export const ToolManifest = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/, "tool name: lowercase snake_case"),
  kind: z.enum(["perception", "controller"]),
  description: z.string(),
  parameters: z
    .record(z.string(), z.unknown())
    .default({ type: "object", properties: {} })
    .describe("JSON Schema for the args object; validated by the harness"),
  entry: z.string().default("tool.py"),
  interpreter: z.string().optional().describe("python executable; defaults to the uv-managed Kinex core Python (.kinex/python/.venv)"),
  timeout_s: z.number().positive().default(120).describe("outer wall-clock cap for one invocation"),
  devices: z
    .array(DeviceType)
    .default([])
    .describe("device TYPES that must have a loaded instance at execute time — the harness refuses the run otherwise"),
  device_inputs: z.record(z.string(), z.strictObject({ types: z.array(DeviceType).min(1), frame: z.literal(true).optional() })).default({}),
  requires: z.string().optional().describe("comma-separated calibration selectors, e.g. intrinsics:rgb,access:model"),
}).superRefine((manifest, ctx) => {
  try {
    z.fromJSONSchema(manifest.parameters)
  } catch (error) {
    ctx.addIssue({ code: "custom", path: ["parameters"], message: error instanceof Error ? error.message : String(error) })
  }
  for (const parameter of Object.keys(manifest.device_inputs)) {
    const property = deviceInputSchema(manifest.parameters, parameter)
    if (!z.object({ type: z.literal("string") }).safeParse(property).success)
      ctx.addIssue({ code: "custom", path: ["device_inputs", parameter], message: "device inputs must reference string parameters" })
  }
})
export type ToolManifest = z.infer<typeof ToolManifest>

export interface PyToolInfo {
  manifest: ToolManifest
  directory: string
}

// Built-in python tools ship at builtin/tool/ (the same shipping model as
// builtin/skill/), scanned LAST so robot/project copies of the same name override.
const builtinDir = () => Assets.builtin("tool")

export const toolRoots = (cwd: string) => contentRoots(cwd, "tools", builtinDir())

// Problems are agent-readable one-liners (the loop appends them to runtime
// context): a tool the agent just wrote must fail loudly, not vanish.
export async function listPyTools(cwd: string): Promise<{ tools: PyToolInfo[]; problems: string[] }> {
  const tools: PyToolInfo[] = []
  const problems: string[] = []
  const seen = new Set<string>()
  for (const toolRoot of await toolRoots(cwd)) {
    if (!(await exists(toolRoot))) continue
    const pattern = "*/tool.yaml"
    for (const entry of (await glob(pattern, { cwd: toolRoot, dot: true })).sort()) {
      const file = path.join(toolRoot, entry)
      const text = await readFile(file, "utf8")
      const raw = (() => {
        try {
          return parseYaml(text)
        } catch (error) {
          return error instanceof Error ? error : new Error(String(error))
        }
      })()
      if (raw instanceof Error) {
        problems.push(`${file}: ${raw.message}`)
        continue
      }
      const parsed = ToolManifest.safeParse(raw)
      if (!parsed.success) {
        problems.push(`${file}: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "manifest"}: ${issue.message}`).join("; ")}`)
        continue
      }
      if (seen.has(parsed.data.name)) continue
      seen.add(parsed.data.name)
      tools.push({ manifest: parsed.data, directory: path.dirname(file) })
    }
  }
  return { tools, problems }
}

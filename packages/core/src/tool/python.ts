import { z } from "zod"
import { define, type Def } from "./tool.ts"
import { runPyTool } from "./python-runner.ts"
import { listPyTools, type ToolManifest } from "./python-catalog.ts"

export { ToolManifest, listPyTools, toolRoots, type PyToolInfo } from "./python-catalog.ts"

const requiresNote = (manifest: ToolManifest) => {
  const parts: string[] = []
  if (manifest.devices.length > 0)
    parts.push(`Needs loaded devices: ${manifest.devices.join(", ")} — the run is refused when a type has no loaded instance.`)
  for (const [parameter, input] of Object.entries(manifest.device_inputs))
    parts.push(`Device input ${parameter}: ${input.types.join(" | ")} (checked against the selected device).`)
  if (manifest.requires) parts.push(`Requires calibration: ${manifest.requires} — check profile readiness before relying on the result.`)
  return parts.length > 0 ? `\n\n${parts.join("\n")}` : ""
}

export async function pythonTools(cwd: string): Promise<{ tools: Def[]; problems: string[] }> {
  const { tools, problems } = await listPyTools(cwd)
  return {
    tools: tools.map((info) =>
      define(info.manifest.name, {
        description: `[${info.manifest.kind} tool, python] ${info.manifest.description}${requiresNote(info.manifest)}`,
        parameters: z.record(z.string(), z.unknown()),
        jsonSchema: info.manifest.parameters,
        execute: (args, ctx) => runPyTool(cwd, info, args, ctx),
      }),
    ),
    problems,
  }
}

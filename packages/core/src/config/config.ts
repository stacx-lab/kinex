import { z } from "zod"
import { loadRawConfig } from "./loader.ts"
import { currentScope } from "../scope.ts"

// Topic bags retain original payloads; capture rates belong to device specs.
export const RecordConfig = z.object({
  max_mb: z.number().positive().default(4096),
})
export type RecordConfig = z.infer<typeof RecordConfig>

export const PythonSettings = z.strictObject({
  provider: z.enum(["uv", "ros-jazzy"]).default("uv"),
  interfaces: z.array(z.string().min(1)).default([]),
})
export const CoreSettings = z.object({
  record: RecordConfig.partial().optional(),
  python: PythonSettings.optional(),
})
export type CoreSettings = z.infer<typeof CoreSettings>
export function recordConfig(config: CoreSettings): RecordConfig { return RecordConfig.parse(config.record ?? {}) }
export async function loadConfig(cwd: string): Promise<CoreSettings> {
  const result = CoreSettings.safeParse(await loadRawConfig(cwd))
  return { ...(result.success ? result.data : {}), ...currentScope().settings }
}

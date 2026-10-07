import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import type { KinexCapabilities } from "@kinex/core/integration"
import type { Mode } from "./interaction.ts"

export async function contextUpdate(runtime: Pick<KinexCapabilities, "context">, ctx: ExtensionContext, problems: string[], mode: Mode) {
  const context = await runtime.context()
  const snapshot: Record<string, string> = {
    ...context.sections,
    interaction: `mode: ${mode}\ninterviews: ${mode === "yolo" || !ctx.hasUI ? "unavailable" : "available"}`,
    problems: [...problems].sort().join("\n"),
  }
  const branch = ctx.sessionManager.getBranch()
  const compactedAt = branch.findLastIndex(entry => entry.type === "compaction")
  const previous = branch.slice(compactedAt + 1).findLast(entry => entry.type === "custom_message" && entry.customType === "kinex-context")
  const data: unknown = previous?.type === "custom_message" ? previous.details : undefined
  const changed = Object.keys(snapshot).filter(key => !data || typeof data !== "object" || !(key in data) || Reflect.get(data, key) !== snapshot[key])
  return {
    instructions: context.instructions,
    message: changed.length ? {
      customType: "kinex-context", display: false, details: snapshot,
      content: `<kinex_context>\n${changed.map(key => `${key}:\n${snapshot[key] || "(none)"}`).join("\n\n")}\n</kinex_context>`,
    } : undefined,
  }
}

import { setupSkillRoots, setupToolNames } from "@kinex/setup"
import path from "node:path"
import { createKinexRuntime, type KinexRuntime } from "@kinex/core"
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Interaction, type Mode } from "./interaction.ts"

// Workspace ownership outlives SDK sessions and extension reloads.
export class RoboticsOwner {
  readonly interaction: Interaction
  runtime?: KinexRuntime
  failure?: Error
  private trace?: ExtensionContext["sessionManager"]
  private observed = new Set<string>()
  constructor(public enableRecording: boolean, mode: Mode) { this.interaction = new Interaction(mode) }

  async enter(cwd: string): Promise<KinexRuntime> {
    const directory = path.resolve(cwd)
    if (this.runtime?.directory === directory) return this.runtime
    await this.dispose()
    this.runtime = createKinexRuntime({ directory, builtinSkillRoots: setupSkillRoots, reservedToolNames: setupToolNames, enableRecording: this.enableRecording, host: {
      ...this.interaction.host,
      exportTrace: async (sessionID, range) => {
        if (this.trace?.getSessionId() !== sessionID) return { sessionID, messages: [] }
        const entries = this.trace.getBranch().filter(entry => entry.type === "message")
        const first = range.first ? entries.findIndex(entry => entry.id === range.first) : 0
        const last = range.last ? entries.findIndex(entry => entry.id === range.last) : entries.length - 1
        return { sessionID, messages: entries.slice(Math.max(0, first), last < 0 ? undefined : last + 1).map(entry => ({
          id: entry.id, role: entry.message.role,
          content: "content" in entry.message ? cleanContent(entry.message.content) : [],
        })) }
      },
    } })
    return this.runtime
  }

  bind(ctx: ExtensionContext) {
    this.trace = ctx.sessionManager
    this.observed = new Set(ctx.sessionManager.getBranch().map(entry => entry.id))
  }

  observeMessages(ctx: ExtensionContext) {
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message" || this.observed.has(entry.id)) continue
      this.observed.add(entry.id)
      this.runtime?.observe({ type: "message", sessionID: ctx.sessionManager.getSessionId(), id: entry.id,
        completed: entry.message.role === "assistant" && entry.message.stopReason !== "toolUse" })
    }
  }

  async leaveSession() {
    this.interaction.reset()
    await this.runtime?.recording.stop({ summary: "Chat session ended" })
    this.trace = undefined
  }

  async dispose() {
    this.interaction.reset()
    const runtime = this.runtime
    this.runtime = undefined
    try { await runtime?.dispose() } finally { this.trace = undefined }
  }
}

function cleanContent(content: unknown): unknown {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return []
  return content.flatMap<unknown>((block: unknown) => {
    if (!block || typeof block !== "object" || !("type" in block)) return []
    if (block.type === "text" && "text" in block) return [{ type: "text", text: block.text }]
    if (block.type === "toolCall" && "name" in block && "arguments" in block) return [{ type: "toolCall", name: block.name, arguments: block.arguments }]
    if (block.type === "image") return [{ type: "image", omitted: true }]
    return []
  })
}

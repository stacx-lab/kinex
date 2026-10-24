import { readFile } from "node:fs/promises"
import { Unsafe } from "typebox"
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent"
import { PermissionDeniedError, QuestionDeclinedError, type Result } from "@kinex/core"
import type { KinexCapabilities } from "@kinex/core/integration"
import type { Interaction } from "./interaction.ts"
import { toolRenderers } from "./render.ts"

export async function piResult(result: Result, signal?: AbortSignal): Promise<Awaited<ReturnType<ToolDefinition["execute"]>>> {
  const content: Awaited<ReturnType<ToolDefinition["execute"]>>["content"] = [{ type: "text", text: result.output }]
  for (const attachment of result.attachments ?? []) {
    const data = attachment.data ?? (await readFile(attachment.path, { signal })).toString("base64")
    content.push({ type: "image", mimeType: attachment.mime, data })
  }
  return { content, details: { kinex: { title: result.title, isError: result.isError, metadata: result.metadata } } }
}

export function toolBridge(pi: ExtensionAPI, runtime: Pick<KinexCapabilities, "tools">, interaction: Interaction) {
  const registered = new Map<string, string>()
  const present = new Set<string>()
  return {
    owns: (name: string) => registered.has(name),
    async refresh(bound = false) {
      const catalog = await runtime.tools.list()
      const foreign = new Set(bound ? pi.getAllTools().map(tool => tool.name).filter(name => !registered.has(name)) : [])
      // Built-ins must retain their native semantics even before session binding.
      for (const name of ["read", "write", "edit", "bash", "grep", "find", "ls", "question"]) foreign.add(name)
      const problems = [...catalog.problems]
      const next = new Set<string>()
      const added: string[] = []
      for (const tool of catalog.tools) {
        const { name } = tool
        if (foreign.has(name)) { problems.push(`Kinex tool ${name} conflicts with a host tool`); continue }
        if (next.has(name)) throw new Error(`Kinex tool names collide in the host: ${name}`)
        next.add(name)
        if (!present.has(name)) added.push(name)
        const fingerprint = JSON.stringify(tool)
        if (registered.get(name) === fingerprint) continue
        pi.registerTool({
          name, label: `Kinex ${name}`, description: tool.description,
          ...toolRenderers(name),
          parameters: Unsafe<Record<string, unknown>>(tool.inputSchema), executionMode: "sequential",
          async execute(callID, args, signal, _update, ctx) {
            if (!present.has(name)) throw new Error(`Tool ${name} is no longer available`)
            try {
              return await interaction.run(ctx, signal, async combined => piResult(await runtime.tools.call(name, args, {
                sessionID: ctx.sessionManager.getSessionId(), callID, abort: combined, directory: ctx.cwd,
                ask: async request => { await interaction.host.ask?.(request) }, questions: questions => interaction.questions(questions),
              }), combined))
            } catch (error) {
              if (error instanceof PermissionDeniedError || error instanceof QuestionDeclinedError) ctx.abort()
              throw error
            }
          },
        })
        registered.set(name, fingerprint)
      }
      const removed = new Set([...present].filter(name => !next.has(name)))
      present.clear()
      for (const name of next) present.add(name)
      return { problems, added, removed }
    },
    async refreshActive() {
      const result = await this.refresh(true)
      if (result.added.length || result.removed.size) pi.setActiveTools([...new Set([
        ...pi.getActiveTools().filter(name => !result.removed.has(name)), ...result.added,
      ])])
      return result.problems
    },
  }
}

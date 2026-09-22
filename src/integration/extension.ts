import { readFile } from "node:fs/promises"
import { Type } from "typebox"
import { Text } from "@earendil-works/pi-tui"
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent"
import { type KinexRuntime } from "@kinex/core"
import { formatJSON } from "@kinex/core/util/json"
import type { KinexCapabilities } from "@kinex/core/integration"
import { registerCommands, executeCommand } from "@kinex/pi/commands"
import type { RoboticsOwner } from "@kinex/pi/owner"
import { contextUpdate } from "@kinex/pi/context"
import { toolBridge, registerSkillTool } from "@kinex/pi/tools"
import { recordingIndicator } from "@kinex/pi/recording-indicator"
import type { CompactionControl } from "./compaction.ts"

export interface SessionControl {
  prompt(text: string): Promise<void>
  settle(): Promise<void>
  compaction: CompactionControl
}

export function kinexExtension(owner: RoboticsOwner, runtime: KinexRuntime, capabilities: KinexCapabilities, report: (text: string) => void, session: SessionControl): ExtensionFactory {
  return async (pi: ExtensionAPI) => {
    const instructions = await readFile(new URL("./instructions.txt", import.meta.url), "utf8")
    registerSkillTool(pi, capabilities)
    const bridge = toolBridge(pi, capabilities, owner.interaction)
    await bridge.refresh()
    let unsubscribe: (() => void) | undefined
    let devices: string[] = []
    let active = false
    let statusGeneration = 0
    const indicator = recordingIndicator()
    const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error") => {
      if (ctx.hasUI) ctx.ui.notify(message, level)
      else console.error(`Kinex: ${message}`)
    }
    const status = async (ctx: ExtensionContext) => {
      if (!active) return
      const generation = ++statusGeneration
      const list = await runtime.devices.list()
      if (!active || generation !== statusGeneration) return
      devices = list.map(device => device.name)
      if (ctx.hasUI) ctx.ui.setStatus("kinex", `Kinex · ${list.filter(device => device.loaded).length}/${list.length} devices · ${owner.interaction.mode}`)
    }
    const execute = async (name: string, args: string, ctx: ExtensionContext) => {
      try {
        const command = capabilities.commands.find(command => command.name === name)
        if (!command) throw new Error(`Unknown command: ${name}`)
        const result = await executeCommand(command, args, ctx)
        if (result.kind === "workflow") await session.prompt(result.prompt)
        else {
          pi.sendMessage({ customType: "kinex", content: result.text, display: true }, { triggerTurn: false })
          if (!ctx.hasUI) report(result.text)
          if (result.isError) owner.failure = new Error(result.text)
        }
      } catch (error) {
        owner.failure = error instanceof Error ? error : new Error(String(error))
        if (!ctx.hasUI) throw error
        ctx.ui.notify(owner.failure.message, "error")
      } finally { await status(ctx) }
    }
    await registerCommands(pi, capabilities.commands, execute)
    pi.on("input", async (event, ctx) => {
      const match = /^\/reload\s+(.+)$/s.exec(event.text.trim())
      if (!match?.[1]) return { action: "continue" }
      await execute("reload", match[1], ctx)
      return { action: "handled" }
    })
    pi.registerCommand("mode", {
      description: "Set Kinex permissions: ask, auto, yolo",
      handler: async (args, ctx) => {
        const selection = args.trim() || (ctx.hasUI ? await ctx.ui.select("Kinex mode", ["ask", "auto", "yolo"]) : owner.interaction.mode)
        if (selection !== "ask" && selection !== "auto" && selection !== "yolo") return
        owner.interaction.reset()
        owner.interaction.mode = selection
        await status(ctx)
      },
    })
    pi.registerTool({
      name: "question", label: "Question", description: "Ask the user for missing facts or choices.",
      executionMode: "sequential",
      parameters: Type.Object({ questions: Type.Array(Type.Object({ header: Type.String(), question: Type.String(), options: Type.Array(Type.Object({ label: Type.String(), description: Type.Optional(Type.String()) })), multiple: Type.Optional(Type.Boolean()) })) }),
      async execute(_id, args, signal, _update, ctx) {
        try {
          const answers = await owner.interaction.run(ctx, signal, () => owner.interaction.questions(args.questions))
          return { content: [{ type: "text", text: formatJSON(answers) }], details: { answers } }
        } catch (error) { ctx.abort(); throw error }
      },
    })
    pi.on("session_start", async (_event, ctx) => {
      active = true
      owner.bind(ctx)
      if (ctx.hasUI) {
        ctx.ui.setHeader((_tui, theme) => new Text(`${theme.fg("accent", "Kinex")} · robotics coding agent`, 1, 1))
        ctx.ui.addAutocompleteProvider(current => ({
          async getSuggestions(lines, line, col, options) {
            const prefix = lines[line]?.slice(0, col) ?? ""
            const match = /^\/reload\s+(\S*)$/.exec(prefix)
            if (match) return { prefix: match[1] ?? "", items: [...devices, "all"].filter(name => name.startsWith(match[1] ?? "")).map(name => ({ value: name, label: name })) }
            return current.getSuggestions(lines, line, col, options)
          },
          applyCompletion: (...args) => current.applyCompletion(...args),
        }))
      }
      unsubscribe = runtime.subscribe(event => {
        if (event.type === "recording.warning") notify(ctx, event.message, "warning")
      })
      await indicator.bind(runtime, ctx)
      for (const activation of await runtime.devices.warmLoaded()) void activation.ready.catch(error => notify(ctx, `${activation.device.name}: ${String(error)}`, "error"))
      await bridge.refreshActive(ctx)
      await status(ctx)
    })
    pi.on("session_shutdown", async event => {
      active = false
      statusGeneration++
      indicator.clear()
      session.compaction.end()
      unsubscribe?.()
      await session.settle()
      if (event.reason === "quit") await owner.dispose()
      else await owner.leaveSession()
    })
    pi.on("before_agent_start", async (event, ctx) => {
      const problems = await bridge.refreshActive(ctx)
      const context = await contextUpdate(capabilities, ctx, problems)
      event.systemPromptOptions.sections.kinex = `${instructions}\n\n${context.instructions}`
      const failure = session.compaction.recover()
      if (failure && owner.failure === failure) owner.failure = undefined
      return { message: context.message }
    })
    pi.on("session_before_compact", event => { session.compaction.begin(event.signal) })
    pi.on("session_compact_failed", () => { session.compaction.end() })
    pi.on("session_compact", async (_event, ctx) => {
      session.compaction.end()
      try {
        const problems = await bridge.refreshActive(ctx)
        const context = await contextUpdate(capabilities, ctx, problems)
        if (context.message) session.compaction.append(context.message)
        const failure = session.compaction.recover()
        if (failure && owner.failure === failure) owner.failure = undefined
      } catch (error) {
        owner.failure = error instanceof Error ? error : new Error(String(error))
        session.compaction.fail(owner.failure)
        ctx.abort()
        throw error
      }
    })
    pi.on("tool_call", async (event, ctx) => {
      const permission = event.toolName === "bash" ? "shell" : event.toolName === "write" || event.toolName === "edit" ? event.toolName : undefined
      if (!permission) return
      try {
        await owner.interaction.run(ctx, undefined, async () => owner.interaction.host.ask?.({ permission, description: JSON.stringify(event.input) }))
      } catch (error) {
        // Abort the whole run as a denied sibling must not allow further model actions.
        ctx.abort()
        return { block: true, terminate: true, reason: error instanceof Error ? error.message : String(error) }
      }
    })
    pi.on("tool_result", event => {
      if (!bridge.owns(event.toolName)) return
      const details: unknown = event.details
      if (details && typeof details === "object" && "kinex" in details && details.kinex && typeof details.kinex === "object" && "isError" in details.kinex) return { isError: details.kinex.isError === true }
    })
    // Pi emits message_end to extensions before persisting that message. These
    // boundaries run after persistence, so recording references real entry IDs.
    pi.on("turn_end", async (_event, ctx) => {
      owner.observeMessages(ctx)
      if (ctx.signal?.aborted) return
      const problems = await bridge.refreshActive(ctx)
      const context = await contextUpdate(capabilities, ctx, problems)
      // Pi flushes these after the complete tool batch, before preparing the next
      // request. Updating context must not start another turn after a final reply.
      if (!ctx.signal?.aborted && context.message) pi.sendMessage(context.message, { triggerTurn: false })
    })
    pi.on("agent_end", (_event, ctx) => owner.observeMessages(ctx))
    pi.on("agent_settled", (_event, ctx) => status(ctx))
    pi.on("tool_execution_start", event => { if (!bridge.owns(event.toolName)) runtime.observe({ type: "tool", callID: event.toolCallId, name: event.toolName, status: "running" }) })
    pi.on("tool_execution_end", event => { if (!bridge.owns(event.toolName)) runtime.observe({ type: "tool", callID: event.toolCallId, name: event.toolName, status: event.isError ? "error" : "completed", isError: event.isError }) })
  }
}

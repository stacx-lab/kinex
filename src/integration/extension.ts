import { Type } from "typebox"
import { Text } from "@earendil-works/pi-tui"
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent"
import { type KinexRuntime } from "@kinex/core"
import { formatJSON } from "@kinex/core/util/json"
import type { KinexCapabilities } from "@kinex/core/integration"
import { registerCommands, executeCommand, commandProgress, type SessionUI } from "./commands.ts"
import type { RoboticsOwner } from "./owner.ts"
import { contextUpdate } from "./context.ts"
import { attachedImages, toolBridge } from "./tools.ts"
import { commandRow, toolRenderers, type CommandRow } from "./render.ts"
import { footerIndicator } from "./footer.ts"
import { formatElapsed, sessionTime, sessionTimeEntry } from "./session-time.ts"
import type { CompactionControl } from "./compaction.ts"
import INSTRUCTIONS from "./instructions.txt"

export interface SessionControl {
  prompt(text: string): Promise<void>
  settle(): Promise<void>
  compaction: CompactionControl
}

export function kinexExtension(owner: RoboticsOwner, runtime: KinexRuntime, capabilities: KinexCapabilities, report: (text: string) => void, session: SessionControl): ExtensionFactory {
  return async (pi: ExtensionAPI) => {
    const bridge = toolBridge(pi, capabilities, owner.interaction)
    await bridge.refresh()
    let unsubscribe: (() => void) | undefined
    // Pi makes an extension for each session and rejects its pi and every ctx once that session is replaced
    // or reloaded, which follows session_shutdown. The runtime, its devices and a running command go on, so
    // what they report later asks active first: ui is the one way from them to the session's UI.
    let active = false
    const ui: SessionUI = ctx => active && ctx.hasUI ? ctx.ui : undefined
    let statusGeneration = 0
    const time = sessionTime(milliseconds => pi.appendEntry(sessionTimeEntry, { milliseconds }))
    const indicator = footerIndicator(() => formatElapsed(time.milliseconds))
    const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error") => {
      if (!active) return
      if (ctx.hasUI) ctx.ui.notify(message, level)
      else console.error(`Kinex: ${message}`)
    }
    const status = async (ctx: ExtensionContext) => {
      if (!active) return
      const generation = ++statusGeneration
      const list = await runtime.devices.list()
      if (generation !== statusGeneration) return
      ui(ctx)?.setStatus("kinex", `Kinex · ${list.filter(device => device.loaded).length}/${list.length} devices · ${owner.interaction.mode}`)
    }
    // The model reads the text, which states which user command produced it; the user sees the row drawn from the details.
    type Command = Pick<CommandRow, "name" | "args">
    type Outcome = Omit<NonNullable<CommandRow["result"]>, "text">
    const heading = (command: Command) => `User ran /${[command.name, command.args].filter(Boolean).join(" ")}:\n`
    const post = (command: Command, text: string, outcome: Outcome) =>
      pi.sendMessage({ customType: "kinex", content: heading(command) + text, display: true, details: { ...command, ...outcome } }, { triggerTurn: false })
    pi.registerMessageRenderer<Command & Outcome>("kinex", (message, options, theme) => {
      const { details, content } = message
      if (!details || typeof content !== "string" || !content.startsWith(heading(details))) return undefined
      const { name, args, ...outcome } = details
      return commandRow({ name, args, result: { ...outcome, text: content.slice(heading(details).length) } }, theme, options)
    })
    // A command's fault is the session's failure: shown to the user, thrown where nobody watches.
    const fault = (ctx: ExtensionContext, error: unknown) => {
      owner.failure = error instanceof Error ? error : new Error(String(error))
      if (!ctx.hasUI) throw error
      ctx.ui.notify(owner.failure.message, "error")
    }
    const execute = async (name: string, args: string, ctx: ExtensionContext) => {
      const command = { name, args: args.trim() }
      const progress = commandProgress(ctx, name, command.args, ui)
      const started = performance.now()
      try {
        const found = capabilities.commands.find(item => item.name === name)
        if (!found) throw new Error(`Unknown command: ${name}`)
        const result = await executeCommand(found, args, ctx, ui, progress.signal)
        const images = result.kind === "workflow" ? [] : (await attachedImages(result.attachments)).map(({ mimeType, data }) => ({ mimeType, data }))
        progress.end()
        // The command ran on past its session: nobody is left to read its outcome.
        if (!active) return
        if (result.kind === "workflow") await session.prompt(result.prompt)
        else {
          post(command, result.text, { isError: result.isError === true, durationMs: performance.now() - started, images })
          if (!ctx.hasUI) report(result.text)
          if (result.isError) owner.failure = new Error(result.text)
        }
      } catch (error) {
        progress.end()
        if (!active) return
        // The user's own cancellation is an outcome the model should know about, not a fault.
        if (progress.cancelled()) return post(command, "Cancelled by the user", { isError: true, durationMs: performance.now() - started })
        fault(ctx, error)
      } finally { await status(ctx) }
    }
    await registerCommands(pi, capabilities.commands, execute)
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
      name: "question", label: "Question", description: "Ask the user for missing facts or choices.", ...toolRenderers("question"),
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
      time.restore(ctx.sessionManager.getEntries())
      if (ctx.hasUI) {
        ctx.ui.setHeader((_tui, theme) => new Text(`${theme.fg("accent", "Kinex")} · robotics coding agent`, 1, 1))
      }
      unsubscribe = runtime.subscribe(event => {
        if (event.type === "recording.warning") notify(ctx, event.message, "warning")
      })
      await indicator.bind(runtime, ctx)
      // Warming is the runtime's: it may fail after this session, and the session that follows reports it.
      for (const activation of await runtime.devices.warmLoaded()) void activation.ready.catch(error => notify(ctx, `${activation.device.name}: ${String(error)}`, "error"))
      if (!active) return
      await bridge.refreshActive()
      await status(ctx)
    })
    pi.on("session_shutdown", async event => {
      active = false
      statusGeneration++
      time.stop()
      indicator.clear()
      session.compaction.end()
      unsubscribe?.()
      await session.settle()
      if (event.reason === "quit") await owner.dispose()
      else await owner.leaveSession()
    })
    pi.on("before_agent_start", async (event, ctx) => {
      const problems = await bridge.refreshActive()
      const context = await contextUpdate(capabilities, ctx, problems)
      event.systemPromptOptions.sections.kinex = `${INSTRUCTIONS}\n\n${context.instructions}`
      const failure = session.compaction.recover()
      if (failure && owner.failure === failure) owner.failure = undefined
      return { message: context.message }
    })
    const endCompaction = () => {
      session.compaction.end()
      time.endCompaction()
      indicator.refresh(time.active)
    }
    pi.on("session_before_compact", event => {
      session.compaction.begin(event.signal)
      // Pi can compact before agent_start as well as within an active run.
      if (event.reason !== "manual") time.startCompaction()
      indicator.refresh(time.active)
    })
    pi.on("session_compact_failed", endCompaction)
    pi.on("session_compact", async (_event, ctx) => {
      session.compaction.end()
      try {
        const problems = await bridge.refreshActive()
        const context = await contextUpdate(capabilities, ctx, problems)
        if (context.message) session.compaction.append(context.message)
        const failure = session.compaction.recover()
        if (failure && owner.failure === failure) owner.failure = undefined
      } catch (error) {
        owner.failure = error instanceof Error ? error : new Error(String(error))
        session.compaction.fail(owner.failure)
        ctx.abort()
        throw error
      } finally { endCompaction() }
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
      const problems = await bridge.refreshActive()
      const context = await contextUpdate(capabilities, ctx, problems)
      // Pi flushes these after the complete tool batch, before preparing the next
      // request. Updating context must not start another turn after a final reply.
      if (!ctx.signal?.aborted && context.message) pi.sendMessage(context.message, { triggerTurn: false })
    })
    pi.on("agent_start", () => { time.start(); indicator.refresh(time.active) })
    pi.on("ui_prompt_start", () => { time.pause(); indicator.refresh(time.active) })
    pi.on("ui_prompt_end", () => { time.resume(); indicator.refresh(time.active) })
    pi.on("agent_end", (_event, ctx) => owner.observeMessages(ctx))
    pi.on("agent_settled", (_event, ctx) => { time.stop(); indicator.refresh(false); return status(ctx) })
    pi.on("tool_execution_start", event => { if (!bridge.owns(event.toolName)) runtime.observe({ type: "tool", callID: event.toolCallId, name: event.toolName, status: "running" }) })
    pi.on("tool_execution_end", event => { if (!bridge.owns(event.toolName)) runtime.observe({ type: "tool", callID: event.toolCallId, name: event.toolName, status: event.isError ? "error" : "completed", isError: event.isError }) })
  }
}

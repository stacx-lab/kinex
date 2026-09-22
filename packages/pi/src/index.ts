import { readFile } from "node:fs/promises"
import path from "node:path"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { SessionManager } from "@earendil-works/pi-coding-agent"
import { composeContributions, coreContribution, type KinexCapabilities, type KinexContribution } from "@kinex/core/integration"
import type { KinexRuntime } from "@kinex/core"
import { RoboticsOwner } from "./owner.ts"
import { toolBridge, registerSkillTool } from "./tools.ts"
import { executeCommand, registerCommands } from "./commands.ts"
import { projectContext } from "./native-context.ts"
import { recordingIndicator } from "./recording-indicator.ts"

export interface PiOptions {
  contributions?(runtime: KinexRuntime): readonly KinexContribution[]
}

export function createPiExtension(options: PiOptions = {}) {
  // Pi caches extension factories while rebuilding cwd-bound SDK services for
  // /new and /resume. Ownership must outlive each invocation of that factory.
  const owner = new RoboticsOwner(false, "ask")
  return async (pi: ExtensionAPI) => {
    pi.registerFlag("kinex-recording", { description: "Enable model access to Kinex recording", type: "boolean", default: false })
    let capabilities: KinexCapabilities | undefined
    let unsubscribe: (() => void) | undefined
    let commandsRegistered = false
    let skillRegistered = false
    let blocked: Error | undefined
    let leavingWorkspace = false
    const indicator = recordingIndicator()
    let statusGeneration = 0
    let active = false
    const instructions = await readFile(new URL("./instructions.txt", import.meta.url), "utf8")
    const current = () => {
      if (!capabilities) throw new Error("Kinex session is not initialized")
      return capabilities
    }
    const bridge = toolBridge(pi, { tools: { list: () => current().tools.list(), call: (...args) => current().tools.call(...args) } }, owner.interaction, true)
    const status = async (ctx: ExtensionContext) => {
      if (!active || !ctx.hasUI || !owner.runtime) return
      const generation = ++statusGeneration
      const devices = await owner.runtime.devices.list()
      if (active && generation === statusGeneration) ctx.ui.setStatus("kinex", `Kinex · ${devices.filter(device => device.loaded).length}/${devices.length} devices · ${owner.interaction.mode}`)
    }
    pi.registerCommand("kinex-mode", {
      description: "Kinex tool permissions: ask, auto, yolo (does not change Pi coding tools)",
      handler: async (args, ctx) => {
        const mode = args.trim() || (ctx.hasUI ? await ctx.ui.select("Kinex permissions", ["ask", "auto", "yolo"]) : "ask")
        if (mode !== "ask" && mode !== "auto" && mode !== "yolo") throw new Error("Expected ask, auto or yolo")
        owner.interaction.reset(); owner.interaction.mode = mode
        await status(ctx)
      },
    })
    pi.on("session_start", async (_event, ctx) => {
      try {
        active = true
        const enableRecording = pi.getFlag("kinex-recording") === true
        if (owner.enableRecording !== enableRecording) { await owner.dispose(); owner.enableRecording = enableRecording }
        const runtime = await owner.enter(ctx.cwd)
        owner.bind(ctx)
        capabilities = composeContributions(options.contributions?.(runtime) ?? [coreContribution(runtime)])
        await capabilities.tools.list()
        await capabilities.skills.list()
        if (!skillRegistered) {
          if (pi.getAllTools().some(tool => tool.name === "kinex_skill")) throw new Error("Kinex skill tool conflicts with an existing host tool")
          registerSkillTool(pi, { skills: { list: () => current().skills.list(), load: name => current().skills.load(name) } })
          skillRegistered = true
        }
        if (!commandsRegistered) {
          const commands = capabilities.commands.map(command => ({ ...command,
            choices: command.choices ? () => current().commands.find(item => item.name === command.name)?.choices?.() ?? Promise.resolve([]) : undefined,
          }))
          await registerCommands(pi, commands, async (name, args, context) => {
            const command = current().commands.find(command => command.name === name)
            if (!command) throw new Error(`Unknown Kinex command: ${name}`)
            const result = await executeCommand(command, args, context)
            if (result.kind === "workflow") pi.sendUserMessage(result.prompt, { deliverAs: "followUp" })
            else pi.sendMessage({ customType: "kinex", content: result.text, display: true }, { triggerTurn: false })
            await status(context)
          }, true)
          commandsRegistered = true
        }
        unsubscribe?.()
        unsubscribe = runtime.subscribe(event => {
          if (event.type === "recording.warning" && ctx.hasUI) ctx.ui.notify(event.message, "warning")
        })
        await indicator.bind(runtime, ctx)
        for (const activation of await runtime.devices.warmLoaded()) void activation.ready.catch(error => {
          if (ctx.hasUI) ctx.ui.notify(String(error), "error")
        })
        await bridge.refreshActive(ctx)
        await status(ctx)
        blocked = undefined
      } catch (error) { active = false; indicator.clear(); await owner.dispose(); throw error }
    })
    pi.on("before_agent_start", async (event, ctx) => {
      try {
        await bridge.refreshActive(ctx)
        event.systemPromptOptions.sections.kinex = `${instructions}\n\n${(await current().context()).instructions}`
      } catch (error) { ctx.abort(); throw error }
    })
    pi.on("context", async (event, ctx) => {
      try {
        await bridge.refreshActive(ctx)
        const result = await projectContext(pi, ctx, event, current())
        blocked = undefined
        return result
      } catch (error) {
        blocked = error instanceof Error ? error : new Error(String(error))
        ctx.abort()
        throw error
      }
    })
    pi.on("tool_call", (event, ctx) => {
      if (!blocked || !bridge.owns(event.toolName)) return
      ctx.abort()
      return { block: true, terminate: true, reason: blocked.message }
    })
    pi.on("tool_result", event => {
      if (!bridge.owns(event.toolName)) return
      const details: unknown = event.details
      if (details && typeof details === "object" && "kinex" in details && details.kinex && typeof details.kinex === "object" && "isError" in details.kinex) return { isError: details.kinex.isError === true }
    })
    pi.on("turn_end", async (_event, ctx) => { owner.observeMessages(ctx); if (!ctx.signal?.aborted) await bridge.refreshActive(ctx) })
    pi.on("agent_end", (_event, ctx) => owner.observeMessages(ctx))
    pi.on("agent_settled", (_event, ctx) => status(ctx))
    pi.on("session_before_switch", (event, ctx) => {
      leavingWorkspace = event.reason === "resume" && !!event.targetSessionFile
        && path.resolve(SessionManager.open(event.targetSessionFile).getCwd()) !== path.resolve(ctx.cwd)
    })
    pi.on("session_shutdown", async event => {
      active = false
      statusGeneration++
      indicator.clear()
      unsubscribe?.(); unsubscribe = undefined
      if (event.reason === "quit" || event.reason === "reload" || leavingWorkspace) await owner.dispose()
      else await owner.leaveSession()
    })
  }
}

export default createPiExtension()

import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { createKinexRuntime, PermissionDeniedError, QuestionDeclinedError, type Context, type KinexRuntime } from "@kinex/core"
import { composeContributions, coreContribution, type KinexContribution } from "@kinex/core/integration"
import type { CommandContext } from "@kinex/core/commands"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import { interaction } from "./interaction.ts"
import { modelResult } from "./result.ts"

export interface CodexOptions {
  directory: string
  enableRecording?: boolean
  contributions?(runtime: KinexRuntime): readonly KinexContribution[]
  diagnostic?(message: string): void
}
const discoveryInput = z.object({ skill: z.string().optional(), workflow: z.string().optional(), arguments: z.string().default("") }).strict()
const callInput = z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()) }).strict()
const stopInput = z.object({ deviceID: z.string().optional(), reason: z.string().optional() }).strict()
const textResult = (value: Record<string, unknown>): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value })

export async function createCodexAdapter(options: CodexOptions) {
  const directory = path.resolve(options.directory)
  const sessionID = randomUUID()
  const lifetime = new AbortController()
  const calls = new AsyncLocalStorage<Context>()
  const runtime = createKinexRuntime({ directory, enableRecording: options.enableRecording, host: {
    ask: request => {
      const call = calls.getStore()
      if (!call) return Promise.reject(new PermissionDeniedError(request.permission))
      return call.ask(request)
    },
    questions: questions => {
      const call = calls.getStore()
      if (!call) return Promise.reject(new QuestionDeclinedError())
      return call.questions(questions)
    },
  } })
  try {
    const capabilities = composeContributions(options.contributions?.(runtime) ?? [coreContribution(runtime)])
    const prose = await readFile(new URL("./instructions.txt", import.meta.url), "utf8")
    const quotedDirectory = `'${directory.replaceAll("'", "'\\''")}'`
    const translate = (text: string) => text.replace(/(?<![\w/.-])\/(devices|load|unload|reload|ping|stop|unregister|record|onboarding|register|calibrate)(?![\w/-])/g,
      (_, name: string) => `kinex-codex control --directory ${quotedDirectory} ${name}`)
    const initial = await capabilities.context()
    const server = new Server({ name: "kinex", version: "0.8.0" }, {
      capabilities: { tools: {} }, instructions: `${prose}\n\n${translate(initial.instructions)}`,
    })
    let previous: Record<string, string> = {}
    let queue: Promise<unknown> = Promise.resolve()
    let generation = 0
    let connected = false
    let disposed: Promise<void> | undefined
    const pending = new Set<Promise<unknown>>()
    const controllers = new Set<AbortController>()
    const diagnostic = options.diagnostic ?? (() => {})
    const context = async (full: boolean, signal: AbortSignal) => {
      const current = await capabilities.context()
      signal.throwIfAborted()
      const sections = current.sections
      const changed = full ? sections : Object.fromEntries([...new Set([...Object.keys(previous), ...Object.keys(sections)])]
        .filter(key => previous[key] !== sections[key]).map(key => [key, sections[key] ?? ""]))
      previous = sections
      return { ...(full ? { instructions: translate(current.instructions) } : {}), sections: changed }
    }
    const interrupt = () => {
      generation++
      previous = {}
      for (const controller of controllers) controller.abort(new Error("Kinex operation cancelled"))
    }
    const run = <T>(signal: AbortSignal, urgent: boolean, fn: (context: Context) => Promise<T>): Promise<T> => {
      if (urgent) interrupt()
      const epoch = generation
      const controller = new AbortController()
      const abort = AbortSignal.any([lifetime.signal, signal, controller.signal])
      const invalidate = () => { if (generation === epoch) { generation++; previous = {} } }
      abort.addEventListener("abort", invalidate, { once: true })
      const execute = async () => {
        abort.throwIfAborted()
        if (epoch !== generation) throw new Error("Kinex queued operation cancelled; wait for user direction")
        controllers.add(controller)
        const call: Context = { directory, sessionID, abort, ...interaction(server, directory, abort) }
        try {
          const result = await calls.run(call, () => fn(call))
          abort.throwIfAborted()
          return result
        } catch (error) {
          if (error instanceof PermissionDeniedError || error instanceof QuestionDeclinedError || abort.aborted) invalidate()
          throw error
        } finally { controllers.delete(controller) }
      }
      const task = urgent ? execute() : queue.then(execute)
      queue = urgent ? Promise.allSettled([queue, task]) : task.catch(() => {})
      pending.add(task)
      void task.finally(() => { pending.delete(task); abort.removeEventListener("abort", invalidate) }).catch(() => {})
      return task
    }
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
      { name: "kinex_tools", description: "Read current Kinex tools, skills and complete robotics context; optionally load a skill or workflow prompt.", inputSchema: z.toJSONSchema(discoveryInput, { io: "input" }), annotations: { readOnlyHint: true } },
      { name: "kinex_call", description: "Call a Kinex tool using its current schema from kinex_tools. Core permissions apply. On denial/cancellation stop and wait for the user.", inputSchema: z.toJSONSchema(callInput, { io: "input" }) },
      { name: "kinex_stop", description: "Immediately cancel active Kinex operations and stop loaded actuators through Core device_stop. No Kinex approval or queue wait.", inputSchema: z.toJSONSchema(stopInput, { io: "input" }) },
    ] }))
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      try {
        const name = request.params.name
        const raw = request.params.arguments ?? {}
        const input = name === "kinex_call" ? callInput.parse(raw) : undefined
        const urgent = name === "kinex_stop" || input?.name === "device_stop"
        // Validate stop arguments before cancelling unrelated work.
        const stop = name === "kinex_stop" ? stopInput.parse(raw) : input?.name === "device_stop" ? stopInput.parse(input.arguments) : undefined
        return await run(extra.signal, urgent, async invocation => {
          if (name === "kinex_tools") {
            const input = discoveryInput.parse(raw)
            if (input.skill && input.workflow) throw new Error("Choose skill or workflow, not both")
            const catalog = await capabilities.tools.list()
            const skill = input.skill ? await capabilities.skills.load(input.skill) : undefined
            if (input.skill && !skill) throw new Error(`Unknown Kinex skill: ${input.skill}`)
            let workflow: string | undefined
            if (input.workflow) {
              const command = capabilities.commands.find(command => command.name === input.workflow && command.kind === "workflow")
              if (!command) throw new Error(`Unknown Kinex workflow: ${input.workflow}`)
              const result = await command.execute(input.arguments, { sessionID, signal: invocation.abort, confirm: async () => false })
              if (result.kind !== "workflow") throw new Error("Workflow did not return a prompt")
              workflow = translate(result.prompt)
            }
            return textResult({ ...catalog, skills: await capabilities.skills.list(), workflows: capabilities.commands.filter(command => command.kind === "workflow").map(({ name, description, arguments: args }) => ({ name, description, arguments: args })), context: await context(true, invocation.abort), ...(skill ? { skill: { ...skill, content: translate(skill.content) } } : {}), ...(workflow ? { workflow } : {}) })
          }
          if (name !== "kinex_stop" && !input) throw new Error(`Unknown MCP tool: ${name}`)
          const result = await capabilities.tools.call(input?.name ?? "device_stop", input?.arguments ?? stop, { ...invocation, callID: String(extra.requestId) })
          const response = await modelResult(result)
          try {
            const update = await context(false, invocation.abort)
            if (Object.keys(update.sections).length) response.content.push({ type: "text", text: JSON.stringify({ context: update }) })
          } catch (error) {
            invocation.abort.throwIfAborted()
            previous = {}
            response.content.push({ type: "text", text: `Tool execution finished, but context refresh failed: ${String(error)}. Do not repeat the operation to refresh context; use kinex_tools.` })
          }
          return response
        })
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }] }
      }
    })
    const dispose = () => disposed ??= (async () => {
      lifetime.abort(new Error("Kinex adapter disposed"))
      interrupt()
      // Abort Core initialization too: trusted commands can be waiting on its lanes.
      const [resources] = await Promise.allSettled([runtime.dispose(), ...pending])
      await server.close()
      if (resources?.status === "rejected") throw resources.reason
    })()
    return {
      runtime, capabilities, sessionID, server,
      async connect(transport: Transport) {
        if (connected) throw new Error("Kinex adapter already connected")
        lifetime.signal.throwIfAborted()
        connected = true
        // Reserve device initialization lanes before accepting tool requests.
        try {
          for (const activation of await runtime.devices.warmLoaded()) {
            void activation.ready.catch(error => diagnostic(`${activation.device.name}: ${String(error)}`))
          }
          server.onclose = () => { void dispose().catch(error => diagnostic(String(error))) }
          server.onerror = error => diagnostic(String(error))
          lifetime.signal.throwIfAborted()
          await server.connect(transport)
        } catch (error) {
          await dispose()
          throw error
        }
      },
      command(name: string, args: string, input: Pick<CommandContext, "confirm" | "notify" | "signal">) {
        const command = capabilities.commands.find(command => command.name === name)
        if (!command) return Promise.reject(new Error(`Unknown Kinex command: ${name}`))
        return run(input.signal ?? lifetime.signal, command.interrupt === true, async invocation => {
          const result = await command.execute(args, { ...input, sessionID, signal: invocation.abort })
          return result.kind === "workflow" ? { ...result, prompt: translate(result.prompt) } : { ...result, text: translate(result.text) }
        })
      },
      dispose,
    }
  } catch (error) { await runtime.dispose(); throw error }
}
export type CodexAdapter = Awaited<ReturnType<typeof createCodexAdapter>>

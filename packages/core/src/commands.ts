import type { KinexRuntime } from "./runtime.ts"
import { parseSpecs } from "./record/spec.ts"
import { recordingOutput } from "./record/output.ts"

export const roboticsCommands = [
  { name: "devices", description: "List devices and activation intent", arguments: "", kind: "operation" },
  { name: "load", description: "Activate devices", arguments: "<device|all>", kind: "operation" },
  { name: "unload", description: "Deactivate devices", arguments: "<device|all>", kind: "operation" },
  { name: "reload", description: "Restart device drivers", arguments: "<device|all>", kind: "operation" },
  { name: "ping", description: "Inspect live device status", arguments: "<device|all>", kind: "operation" },
  { name: "stop", description: "Stop actuators", arguments: "[device]", kind: "operation" },
  { name: "record", description: "Capture observations", arguments: "start|snap|stop|status [--verbose] ...", kind: "operation" },
] as const

export type RoboticsCommand = typeof roboticsCommands[number]["name"]
export type CommandResult = { kind: "output"; text: string; isError?: boolean } | { kind: "workflow"; prompt: string }
export interface CommandContext {
  sessionID: string
  signal?: AbortSignal
  confirm(title: string, description: string): Promise<boolean>
  notify?(message: string): void
}

export function isRoboticsCommand(name: string): name is RoboticsCommand {
  return roboticsCommands.some(command => command.name === name)
}

// Trusted user-command API. Model calls must use runtime.tools.call instead.
export async function executeRoboticsCommand(runtime: KinexRuntime, name: RoboticsCommand, args: string, context: CommandContext): Promise<CommandResult> {
  context.signal?.throwIfAborted()
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  const output = (text: string): CommandResult => ({ kind: "output", text })
  if (name === "devices") {
    if (tokens.length) throw new Error("Usage: /devices")
    return output((await runtime.devices.list()).map(device => `${device.name}: ${device.type}, ${device.loaded ? "loaded" : "unloaded"}`).join("\n") || "No devices configured.")
  }
  if (name === "stop") {
    if (tokens.length > 1) throw new Error("Usage: /stop [device]")
    const result = await runtime.tools.call("device_stop", { deviceID: tokens[0] }, { sessionID: context.sessionID })
    return { kind: "output", text: result.output, isError: result.isError }
  }
  if (name === "record") return output(await record(runtime, tokens, context.sessionID))
  const device = tokens[0]
  if (!device || tokens.length !== 1) throw new Error(`Usage: /${name} <device|all>`)
  const names = device === "all"
    ? (await runtime.devices.list()).filter(item => name === "load" ? !item.loaded : item.loaded).map(item => item.name)
    : [device]
  const results = await Promise.allSettled(names.map(async target => {
    if (name === "unload") { await runtime.devices.unload(target); return `${target} unloaded` }
    if (name === "ping") return `${target}: ${JSON.stringify(await runtime.devices.ping(target))}`
    const activation = await runtime.devices[name](target, context.signal)
    if (activation.activating) context.notify?.(`${target}: activating`)
    await activation.ready
    return `${target} ${name === "load" ? "loaded" : "reloaded"}`
  }))
  return { kind: "output", isError: results.some(result => result.status === "rejected"), text: results.map((result, index) =>
    result.status === "fulfilled" ? result.value : `${names[index]}: ${String(result.reason)}`).join("\n") || "No matching devices" }
}

async function record(runtime: KinexRuntime, tokens: string[], sessionID: string): Promise<string> {
  const [verb = "status", ...rest] = tokens
  const verbose = rest[0] === "--verbose"
  if (verbose) rest.shift()
  const json = (value: unknown) => recordingOutput(value, verbose)
  if (verb === "status") {
    if (rest.length) throw new Error("Usage: /record status")
    return json({ active: await runtime.recording.status(), recent: await runtime.recording.recent(5) })
  }
  if (verb === "start") {
    const { specs, instruction } = parseSpecs(rest)
    if (!Object.keys(specs).length) throw new Error("Usage: /record start <device=Hz ...> [instruction]")
    return json(await runtime.recording.start({ specs, instruction, sessionID }))
  }
  if (verb === "snap") {
    const known = new Set((await runtime.devices.list()).map(device => device.name))
    const firstText = rest.findIndex(token => !known.has(token))
    const devices = firstText < 0 ? rest : rest.slice(0, firstText)
    if (!devices.length) throw new Error("Usage: /record snap <devices ...> [instruction]")
    return json(await runtime.recording.snap({ devices, instruction: firstText < 0 ? "" : rest.slice(firstText).join(" "), sessionID }))
  }
  if (verb === "stop") {
    const outcome = rest[0] === "success" || rest[0] === "failure" || rest[0] === "partial" ? rest[0] : undefined
    return json(await runtime.recording.stop({ outcome, summary: (outcome ? rest.slice(1) : rest).join(" ") }))
  }
  throw new Error("Usage: /record start|snap|stop|status")
}

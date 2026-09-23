import { serveProcess, terminate } from "../device/serve-process.ts"
import { spawnProcess } from "../util/process.ts"
import { abortable } from "../util/abort.ts"
import { z } from "zod"
import { pythonRuntime, pythonDiagnostic } from "../python/environment.ts"
import { deviceModel, deviceModelError } from "../calibration/device-model.ts"
import { deviceInputValues } from "./device-input.ts"
import path from "node:path"
import { formatJSON } from "../util/json.ts"
import { CalibrationStore } from "../calibration/store.ts"
import { matchesDeviceType } from "../device/profile/schema.ts"
import { dispatchDevice, stopOwnedMotions } from "../device/dispatch.ts"
import { isCommandAction } from "../device/interface.ts"
import { Assets } from "../installation/assets.ts"
import { imageMime } from "../util/media.ts"
import { NamedError } from "../util/error.ts"
import { readLine, LineTimeoutError } from "../util/lines.ts"
import { create } from "../util/log.ts"
import type { Context, Result } from "./tool.ts"
import type { PyToolInfo } from "./python.ts"
import { listPyTools } from "./python.ts"

const log = create("python-tool")

class PyToolError extends NamedError {
  constructor(message: string, data: Record<string, unknown> = {}) {
    super("PyToolError", message, data)
  }
}

// Shared python helpers shipped with the harness (the `kinex` client lib
// lives in repo-root python/), plus the robot's own lib/ — same import surface
// device drivers get.
const pythonDir = () => Assets.python()

const MAX_DEPTH = 8

// The manifest's `devices:` gate — device TYPES that must have a loaded
// instance before the tool may run. Checked before the permission ask (never
// prompt for a doomed run) and again on composed calls.
async function missingDeviceTypes(cwd: string, manifest: PyToolInfo["manifest"]): Promise<string[]> {
  if (manifest.devices.length === 0) return []
  const robot = await CalibrationStore.readManifest(cwd)
  if (!robot) return [...manifest.devices]
  const devices = await CalibrationStore.listDevices(cwd)
  const loaded = devices.filter((device) => device.loaded).map((device) => device.type)
  // Richer device types satisfy their base contract (RGBD and segmentation).
  return manifest.devices.filter(
    (type) => !loaded.some((have) => matchesDeviceType(have, type)),
  )
}

async function validateInputs(cwd: string, info: PyToolInfo, args: Record<string, unknown>): Promise<void> {
  // Validate without applying schema defaults; tools still receive the original args.
  z.fromJSONSchema(info.manifest.parameters).parse(args)
  for (const [parameter, input] of Object.entries(info.manifest.device_inputs)) {
    for (const value of deviceInputValues(args, info.manifest.parameters, parameter)) {
      if (typeof value !== "string") throw new PyToolError(`device input "${parameter}" must name a device`)
      const name = input.frame ? value.split(":")[0]! : value
      const device = await CalibrationStore.readDevice(cwd, name)
      // The frame graph also recognizes the conventional world frame without a geometry profile.
      if (!device && input.frame && value === "world" && input.types.includes("world")) continue
      if (!device) throw new PyToolError(`device input "${parameter}": unknown device "${name}"`)
      if (!input.types.some((type) => matchesDeviceType(device.type, type)))
        throw new PyToolError(`device input "${parameter}" accepts ${input.types.join(" | ")}; "${name}" is ${device.type}`)
      if (!device.loaded) throw new PyToolError(`device input "${parameter}": "${name}" is unloaded`)
    }
  }
}

const missingDevicesError = (name: string, missing: string[]) =>
  `tool "${name}" requires a loaded device of type ${missing.join(", ")} — none is loaded. /register one or /load an existing device first`

// The tool ↔ harness dialog: the tool process writes one JSON object per line
// on stdout — either a request {"call": ...} (harness answers with one JSON
// line on its stdin) or the terminal {"return": ...} / {"error": ...}. Calls
// are strictly sequential — concurrency lives harness-side: the batched
// "devices" call dispatches its whole command list at once (Promise.all).
// Non-JSON stdout lines are
// ignored (stray prints — the python lib redirects print() to stderr, but be
// tolerant). Capability by manifest kind: perception may read devices /
// profile / robot / call other PERCEPTION tools; controller additionally may
// COMMAND devices (isCommandAction) and call any tool.
type Request = Record<string, unknown>
type MotionContext = Context & { motionOwner: string }

// One device action, validated exactly like the single "device" call — shared
// by it and each entry of the batched "devices" call.
async function deviceCall(
  cwd: string,
  info: PyToolInfo,
  name: unknown,
  actionRaw: unknown,
  argsRaw: unknown,
  signal: AbortSignal,
  owner: string,
): Promise<Record<string, unknown>> {
  if (typeof name !== "string") return { ok: false, error: "device needs a device name" }
  const device = await CalibrationStore.readDevice(cwd, name)
  if (!device) return { ok: false, error: `no device "${name}" in this workspace` }
  const action = typeof actionRaw === "string" ? actionRaw : "read"
  if (action === "load" || action === "unload")
    return { ok: false, error: `"${action}" is unavailable inside Python tools — use the device tool or /${action}` }
  if (!device.loaded) return { ok: false, error: `device "${name}" is unloaded — activate it through the device tool` }
  if (isCommandAction(device, action) && info.manifest.kind !== "controller")
    return { ok: false, error: `perception tool "${info.manifest.name}" may not command a device ("${action}" on ${name}) — only controller tools command devices` }
  const args = (typeof argsRaw === "object" && argsRaw !== null ? argsRaw : {}) as Record<string, unknown>
  const reading = await dispatchDevice(cwd, device, action, args, owner, signal).catch((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
  }))
  if ("error" in reading) return { ok: false, error: reading.error }
  return { ok: true, ...(reading.data ? { data: reading.data } : {}), ...(reading.filePath ? { file: reading.filePath } : {}) }
}

async function dispatch(cwd: string, info: PyToolInfo, request: Request, ctx: MotionContext, depth: number): Promise<Record<string, unknown>> {
  const call = request["call"]
  if (call === "stop_owned") {
    if (info.manifest.kind !== "controller")
      return { ok: false, error: "only controller tools may stop owned motion" }
    try {
      await stopOwnedMotions(cwd, ctx.motionOwner)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
  const robot = await CalibrationStore.readManifest(cwd)
  if (call === "robot") {
    if (!robot) return { ok: false, error: "no robot is onboarded in this project" }
    return { ok: true, robot }
  }
  if (call === "profile") {
    if (!robot) return { ok: false, error: "no robot is onboarded in this project" }
    const name = request["device"]
    if (typeof name !== "string") return { ok: false, error: "profile needs a device name" }
    const device = await CalibrationStore.readDevice(cwd, name)
    if (!device && request["optional"] === true) return { ok: true, profile: null }
    if (!device) return { ok: false, error: `no device "${name}" for robot ${robot.identity.id}` }
    const error = deviceModelError(device)
    if (error) return { ok: false, error }
    const model = deviceModel(device)
    return { ok: true, profile: model ? { ...device, resolved_model: model } : device }
  }
  if (call === "device") {
    if (!robot) return { ok: false, error: "no robot is onboarded in this project" }
    return deviceCall(cwd, info, request["device"], request["action"], request["args"], ctx.abort, ctx.motionOwner)
  }
  if (call === "devices") {
    if (!robot) return { ok: false, error: "no robot is onboarded in this project" }
    const commands = request["commands"]
    if (!Array.isArray(commands) || commands.length === 0)
      return { ok: false, error: "devices needs a non-empty commands array [{device, action?, args?}, ...]" }
    const results = await Promise.all(
      commands.map(async (command) => {
        const entry = (typeof command === "object" && command !== null ? command : {}) as Record<string, unknown>
        const result = await deviceCall(cwd, info, entry["device"], entry["action"], entry["args"], ctx.abort, ctx.motionOwner)
        return { ...(typeof entry["device"] === "string" ? { device: entry["device"] } : {}), ...result }
      }),
    )
    return { ok: true, results }
  }
  if (call === "tool") {
    const name = request["name"]
    if (typeof name !== "string") return { ok: false, error: "tool call needs a name" }
    if (depth >= MAX_DEPTH) return { ok: false, error: `tool composition deeper than ${MAX_DEPTH} — likely a cycle` }
    const target = (await listPyTools(cwd)).tools.find((tool) => tool.manifest.name === name)
    if (!target) return { ok: false, error: `unknown python tool "${name}"` }
    if (info.manifest.kind === "perception" && target.manifest.kind !== "perception")
      return { ok: false, error: `perception tool "${info.manifest.name}" may only compose perception tools, not controller "${name}"` }
    const missing = await missingDeviceTypes(cwd, target.manifest)
    if (missing.length > 0) return { ok: false, error: missingDevicesError(name, missing) }
    const args = (typeof request["args"] === "object" && request["args"] !== null ? request["args"] : {}) as Record<string, unknown>
    return invoke(cwd, target, args, ctx, depth + 1, ctx.motionOwner).then(
      (result) => ({ ok: true, result }),
      (error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    )
  }
  return { ok: false, error: `unknown call "${String(call)}" — use device, devices, tool, profile, robot, or stop_owned` }
}

// Run the dialog to completion; resolves with the tool's return object.
async function invoke(cwd: string, info: PyToolInfo, args: Record<string, unknown>, ctx: Context, depth: number, motionOwner: string = crypto.randomUUID()): Promise<Record<string, unknown>> {
  const signal = AbortSignal.any([ctx.abort, AbortSignal.timeout(Math.ceil(info.manifest.timeout_s * 1000))])
  const scoped = { ...ctx, abort: signal, motionOwner }
  signal.throwIfAborted()
  await validateInputs(cwd, info, args)
  signal.throwIfAborted()
  const entry = path.join(info.directory, info.manifest.entry)
  const runtime = await pythonRuntime(cwd, info.manifest.interpreter, signal)
  const lib = path.join(await CalibrationStore.workspaceDir(cwd), "lib")
  const pythonPath = [pythonDir(), lib, ...(process.env["PYTHONPATH"] ? [process.env["PYTHONPATH"]] : [])].join(path.delimiter)
  signal.throwIfAborted()
  const proc = spawnProcess([runtime.executable, entry, JSON.stringify(args)], {
    cwd: info.directory,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    // KINEX_TOOL_DIALOG marks a real dialog spawn: only then does the
    // kinex lib capture stdout for the protocol (so skill scripts and
    // drivers can import kinex.geometry side-effect-free).
    env: { ...runtime.env, PYTHONPATH: pythonPath, KINEX_TOOL_DIALOG: "1" },
  })
  const onAbort = () => proc.kill()
  signal.addEventListener("abort", onAbort, { once: true })
  if (signal.aborted) onAbort()
  const served = serveProcess(proc)
  const source = served.source
  const deadline = Date.now() + info.manifest.timeout_s * 1000

  const finished = await (async (): Promise<Record<string, unknown>> => {
    for (;;) {
      const line = await abortable(readLine(source, deadline), signal).catch((error: unknown) => {
        if (error instanceof LineTimeoutError || (error instanceof Error && error.name === "TimeoutError")) throw new PyToolError("tool timed out")
        throw error
      })
      if (line === undefined) {
        await abortable(proc.exited, signal)
        const stderr = served.stderr.tail
        const reason = stderr.trim().slice(-4000)
        throw new PyToolError(
          ctx.abort.aborted
            ? "tool interrupted"
            : pythonDiagnostic(reason || `tool exited without a {"return": ...} line`, runtime.executable),
        )
      }
      const message = (() => {
        try {
          return JSON.parse(line) as unknown
        } catch {
          return undefined
        }
      })()
      if (typeof message !== "object" || message === null || Array.isArray(message)) continue // stray print — tolerated
      const parsed = message as Request
      if ("return" in parsed) {
        const value = parsed["return"]
        return (typeof value === "object" && value !== null ? value : { value }) as Record<string, unknown>
      }
      if ("error" in parsed) throw new PyToolError(pythonDiagnostic(String(parsed["error"]), runtime.executable))
      if ("call" in parsed) {
        const response = await abortable(dispatch(cwd, info, parsed, scoped, depth), signal)
        proc.stdin.write(JSON.stringify(response) + "\n")
        await abortable(Promise.resolve(proc.stdin.flush()), signal)
        continue
      }
      // JSON but neither request nor terminal — tolerate like a stray print.
    }
  })().finally(async () => {
    signal.removeEventListener("abort", onAbort)
    await terminate(served, true)
  }).catch(async (error: unknown) => {
    // Stop before returning a failed controller to its caller, including a parent tool.
    if (info.manifest.kind === "controller") {
      await stopOwnedMotions(cwd, motionOwner).catch(failure => { log.warn(String(failure)) })
    }
    throw error
  })
  return finished
}

export async function runPyTool(cwd: string, info: PyToolInfo, args: Record<string, unknown>, ctx: Context): Promise<Result> {
  const { name, kind } = info.manifest
  const missing = await missingDeviceTypes(cwd, info.manifest)
  if (missing.length > 0) throw new PyToolError(missingDevicesError(name, missing))
  await validateInputs(cwd, info, args)
  await ctx.ask(
    kind === "controller"
      ? {
          permission: "python_tool_controller",
          description: `run controller tool ${name} ${JSON.stringify(args)} — it commands devices agent-free until its termination condition`,
        }
      : { permission: "python_tool", description: `run perception tool ${name} ${JSON.stringify(args)}` },
  )
  const returned = await invoke(cwd, info, args, ctx, 0)
  const file = typeof returned["file"] === "string" ? returned["file"] : undefined
  const mime = file ? await imageMime(file) : undefined
  return {
    title: `${name} (${kind} tool)`,
    output: formatJSON(returned),
    ...(mime && file ? { attachments: [{ mime, path: file }] } : {}),
  }
}

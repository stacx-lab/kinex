import { shortID } from "../util/id.ts"
import { serveProcess, terminate } from "../device/serve-process.ts"
import { spawnProcess } from "../util/process.ts"
import { abortable } from "../util/abort.ts"
import { z } from "zod"
import { pythonDiagnostic } from "../python/environment.ts"
import { deviceModel, deviceModelError } from "../device/device-model.ts"
import { deviceInputValues } from "./device-input.ts"
import path from "node:path"
import { formatJSON } from "../util/json.ts"
import { ProfileStore } from "../device/profile/store.ts"
import { matchesDeviceType } from "../device/profile/schema.ts"
import { stopOwnedMotions } from "../device/dispatch.ts"
import { callDevices, DeviceCallSchema, DeviceCallsSchema } from "./device/calls.ts"
import { pythonLaunch } from "../python/launch.ts"
import { imageMime } from "../util/media.ts"
import { PermissionDeniedError, failure, failureMetadata } from "./errors.ts"
import { NamedError } from "../util/error.ts"
import { readLine, LineTimeoutError } from "../util/lines.ts"
import { create } from "../util/log.ts"
import type { Context, Result } from "./tool.ts"
import { listPyTools, type PyToolInfo, type ToolManifest } from "./python-catalog.ts"

const log = create("python-tool")

class PyToolError extends NamedError {
  constructor(message: string, data: Record<string, unknown> = {}) {
    super("PyToolError", message, data)
  }
}

const MAX_DEPTH = 8

// The manifest's `devices:` gate — device TYPES that must have a loaded
// instance before the tool may run. Checked before the permission ask (never
// prompt for a doomed run) and again on composed calls.
async function missingDeviceTypes(cwd: string, manifest: PyToolInfo["manifest"]): Promise<string[]> {
  if (manifest.devices.length === 0) return []
  const robot = await ProfileStore.readManifest(cwd)
  if (!robot) return [...manifest.devices]
  const devices = await ProfileStore.listDevices(cwd)
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
      const device = await ProfileStore.readDevice(cwd, name)
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
  `tool "${name}" requires a loaded device of type ${missing.join(", ")} — none is loaded. configure an instance or /load an existing device first`

// The harness first sends {args, source?} on stdin. The tool then writes one JSON
// object per stdout line — either a request {"call": ...} (harness answers with one JSON
// line on its stdin) or the terminal {"return": ...} / {"error": ...}. Calls
// are strictly sequential — concurrency lives harness-side: the batched
// "devices" call dispatches its whole command list at once (Promise.all).
// Non-JSON stdout lines are
// ignored (stray prints — the python lib redirects print() to stderr, but be
// tolerant). Capability by manifest kind: perception may read devices /
// profile / robot / call other PERCEPTION tools; controller additionally may
// COMMAND devices (isCommandAction) and call any tool.
type Request = Record<string, unknown>
type ExecutionContext = Context & { approved?: boolean; output?: (text: string) => void }
type MotionContext = ExecutionContext & { motionOwner: string }
type PythonExecution = Pick<ToolManifest, "name" | "kind" | "interpreter" | "timeout_s"> & {
  directory: string
  entry: string[]
  source?: string
  script?: { file?: string; argv: string[]; exitCode: number | null }
}

function execution(info: PyToolInfo): PythonExecution {
  const { name, kind, interpreter, timeout_s, entry } = info.manifest
  return { name, kind, interpreter, timeout_s, directory: info.directory, entry: [path.join(info.directory, entry)] }
}

const InlineRequest = z.strictObject({
  call: z.literal("inline"),
  python: z.string().min(1),
  kind: z.enum(["perception", "controller"]),
  args: z.record(z.string(), z.unknown()),
})

async function composed(result: Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    return { ok: true, result: await result }
  } catch (error) {
    if (error instanceof PermissionDeniedError) throw error
    return { ok: false, ...failure(error) }
  }
}

async function dispatchDevices(name: "device" | "devices", input: unknown, ctx: MotionContext, kind: PythonExecution["kind"], authorize: boolean) {
  const calls = name === "device" ? [DeviceCallSchema.parse(input)] : DeviceCallsSchema.parse(input).calls
  const results = await callDevices(calls, ctx, { kind, owner: ctx.motionOwner, authorize })
  if (name === "devices") return { ok: true, result: { results } }
  const result = results[0]!
  return result.ok ? { ok: true, result: { ...result.data, ...(result.file ? { file: result.file } : {}) } }
    : { ok: false, error: result.error, ...failureMetadata({ ...result }) }
}

async function dispatch(cwd: string, info: PythonExecution, request: Request, ctx: MotionContext, depth: number): Promise<Record<string, unknown>> {
  const call = request["call"]
  if (call === "stop_owned") {
    if (info.kind !== "controller")
      return { ok: false, error: "only controller tools may stop owned motion" }
    try {
      await stopOwnedMotions(cwd, ctx.motionOwner)
      return { ok: true }
    } catch (error) {
      return { ok: false, ...failure(error) }
    }
  }
  const robot = await ProfileStore.readManifest(cwd)
  if (call === "robot") {
    if (!robot) return { ok: false, error: "no robot is onboarded in this project" }
    return { ok: true, robot }
  }
  if (call === "profile") {
    if (!robot) return { ok: false, error: "no robot is onboarded in this project" }
    const name = request["device"]
    if (typeof name !== "string") return { ok: false, error: "profile needs a device name" }
    const device = await ProfileStore.readDevice(cwd, name)
    if (!device && request["optional"] === true) return { ok: true, profile: null }
    if (!device) return { ok: false, error: `no device "${name}" for robot ${robot.identity.id}` }
    const error = deviceModelError(device)
    if (error) return { ok: false, error }
    const model = deviceModel(device)
    return { ok: true, profile: model ? { ...device, resolved_model: model } : device }
  }
  if (call === "device" || call === "devices") {
    const { call: _, ...input } = request
    return dispatchDevices(call, input, ctx, info.kind, false)
  }
  if ((call === "tool" || call === "inline") && depth >= MAX_DEPTH)
    return { ok: false, error: `tool composition deeper than ${MAX_DEPTH} — likely a cycle` }
  if (call === "inline") {
    const { python, kind, args } = InlineRequest.parse(request)
    if (info.kind === "perception" && kind !== "perception")
      return { ok: false, error: `perception tool "${info.name}" may only compose perception tools` }
    return composed(invoke(cwd, { ...info, name: "inline", kind, entry: ["-m", "kinex._inline"], source: python, script: undefined }, args, ctx, depth + 1, ctx.motionOwner))
  }
  if (call === "tool") {
    const name = request["name"]
    if (typeof name !== "string") return { ok: false, error: "tool call needs a name" }
    if (name === "device" || name === "devices")
      return dispatchDevices(name, request["args"], ctx, info.kind, !ctx.approved)
    const target = (await listPyTools(cwd)).tools.find((tool) => tool.manifest.name === name)
    if (!target) return { ok: false, error: `unknown python tool "${name}"` }
    if (info.kind === "perception" && target.manifest.kind !== "perception")
      return { ok: false, error: `perception tool "${info.name}" may only compose perception tools, not controller "${name}"` }
    const missing = await missingDeviceTypes(cwd, target.manifest)
    if (missing.length > 0) return { ok: false, error: missingDevicesError(name, missing) }
    const args = z.record(z.string(), z.unknown()).parse(request["args"])
    return composed(validateInputs(cwd, target, args).then(() => invoke(cwd, execution(target), args, ctx, depth + 1, ctx.motionOwner)))
  }
  return { ok: false, error: `unknown call "${String(call)}" — use device, devices, tool, inline, profile, robot, or stop_owned` }
}

// Run the dialog to completion; preserve the returned JSON value, including null.
async function invoke(cwd: string, info: PythonExecution, args: Record<string, unknown>, ctx: ExecutionContext, depth: number, motionOwner: string = shortID()): Promise<unknown> {
  const signal = AbortSignal.any([ctx.abort, AbortSignal.timeout(Math.ceil(info.timeout_s * 1000))])
  const scoped = { ...ctx, abort: signal, motionOwner }
  signal.throwIfAborted()
  const runtime = await pythonLaunch(cwd, "tool", info.interpreter, signal)
  signal.throwIfAborted()
  const request = JSON.stringify({ args, source: info.source, file: info.script?.file, argv: info.script?.argv }) + "\n"
  const proc = spawnProcess([runtime.executable, ...info.entry], {
    cwd: info.directory,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: runtime.env,
    group: true,
  })
  // A script may leave children holding output pipes open after it exits.
  void proc.exit.then(() => proc.kill("SIGKILL")).catch(() => {})
  const onAbort = () => proc.kill()
  signal.addEventListener("abort", onAbort, { once: true })
  if (signal.aborted) onAbort()
  const served = serveProcess(proc, ctx.output)
  const source = served.source
  const deadline = Date.now() + info.timeout_s * 1000

  const dialog = (async (): Promise<unknown> => {
    for (;;) {
      const line = await abortable(readLine(source, deadline), signal).catch((error: unknown) => {
        if (error instanceof LineTimeoutError || (error instanceof Error && error.name === "TimeoutError")) throw new PyToolError("tool timed out")
        throw error
      })
      if (line === undefined) {
        const code = await abortable(proc.exited, signal)
        await served.drained
        if (info.script && code === 0) return null
        const stderr = served.stderr.tail
        const reason = stderr.trim().slice(-4000)
        const message = info.script ? `script exited with code ${code}${reason ? `\n${reason}` : ""}`
          : reason || `tool exited without a {"return": ...} line`
        throw new PyToolError(
          ctx.abort.aborted
            ? "tool interrupted"
            : pythonDiagnostic(message, runtime.executable),
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
        return parsed["return"]
      }
      if ("error" in parsed) throw new PyToolError(pythonDiagnostic(String(parsed["error"]), runtime.executable), failureMetadata(parsed))
      if ("call" in parsed) {
        const response = await abortable(dispatch(cwd, info, parsed, scoped, depth), signal)
        proc.stdin.write(JSON.stringify(response) + "\n")
        await abortable(Promise.resolve(proc.stdin.flush()), signal)
        continue
      }
      // JSON but neither request nor terminal — tolerate like a stray print.
    }
  })()
  // Drain the dialog while sending: a tool may print before importing kinex.
  proc.stdin.write(request)
  const sent = abortable(proc.stdin.flush(), signal).catch((error: unknown) => {
    signal.throwIfAborted()
    throw new PyToolError(`cannot send tool request: ${error instanceof Error ? error.message : String(error)}`)
  })
  const finished = await Promise.all([sent, dialog]).then(([, result]) => result).finally(async () => {
    try {
      await terminate(served, !signal.aborted)
      await served.drained
    } finally {
      signal.removeEventListener("abort", onAbort)
      if (info.script) info.script.exitCode = proc.exitCode
    }
  }).then(result => {
    signal.throwIfAborted()
    if (info.script && proc.exitCode !== 0) throw new PyToolError(`script exited with code ${proc.exitCode}`)
    return result
  }).catch(async (error: unknown) => {
    // Stop before returning a failed controller to its caller, including a parent tool.
    if (info.kind === "controller") {
      await stopOwnedMotions(cwd, motionOwner).catch(failure => { log.warn(String(failure)) })
    }
    throw error
  })
  return finished
}

interface ScriptInput {
  python?: string
  file?: string
  args: Record<string, unknown>
  argv: string[]
  interpreter?: string
  timeout_s: number
}

export async function runScript(input: ScriptInput, ctx: Context): Promise<Result> {
  await ctx.ask({ permission: "python_tool_controller", description: `run Python exec ${JSON.stringify(input)}` })
  const script: NonNullable<PythonExecution["script"]> = {
    file: input.file ? path.resolve(ctx.directory, input.file) : undefined, argv: input.argv, exitCode: null,
  }
  let output = "", dropped = 0
  const capture = (text: string) => {
    output += text
    const length = output.length
    output = output.slice(-16_384)
    // Leave room for JSON escaping and the surrounding result envelope.
    while (JSON.stringify(output).length > 16_384) output = output.slice(Math.ceil(output.length / 4))
    dropped += length - output.length
  }
  let result: unknown, error: ReturnType<typeof failure> | undefined
  try {
    result = await invoke(ctx.directory, {
      name: "exec", kind: "controller", directory: ctx.directory, entry: ["-u", "-m", "kinex._exec"],
      interpreter: input.interpreter, timeout_s: input.timeout_s, source: input.python, script,
    }, input.args, { ...ctx, approved: true, output: capture }, 0)
  } catch (caught) {
    if (caught instanceof PermissionDeniedError) throw caught
    error = failure(caught)
  }
  return {
    title: "exec (Python)",
    output: formatJSON({ exit_code: script.exitCode, output: `${dropped ? `(output truncated: ${dropped} characters dropped)\n` : ""}${output}`,
      ...(error ?? { result }) }),
    ...(error ? { isError: true } : await resultAttachments(result, ctx.directory)),
  }
}

async function resultAttachments(returned: unknown, directory = process.cwd()) {
  const value = z.record(z.string(), z.unknown()).safeParse(returned).data
  const file = value?.["file"]
  const files = z.array(z.string()).safeParse(typeof file === "string" ? [file] : file).data ?? []
  const attachments = (await Promise.all(files.map(async file => {
    const resolved = path.resolve(directory, file)
    const mime = await imageMime(resolved)
    return mime ? [{ mime, path: resolved }] : []
  }))).flat()
  return attachments.length ? { attachments } : {}
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
  await validateInputs(cwd, info, args)
  const returned = await invoke(cwd, execution(info), args, ctx, 0)
  return {
    title: `${name} (${kind} tool)`,
    output: formatJSON(returned),
    ...await resultAttachments(returned, cwd),
  }
}

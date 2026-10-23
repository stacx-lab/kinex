import { rosCatalog, rosReady, enrollRos, cleanupRos } from "../device/ros.ts"
import { shortID } from "../util/id.ts"
import { serveProcess, terminate } from "../device/serve-process.ts"
import { spawnProcess } from "../util/process.ts"
import { abortable } from "../util/abort.ts"
import { z } from "zod"
import { pythonDiagnostic } from "../python/environment.ts"
import { deviceTree, modelErrors } from "../device/profile/urdf.ts"
import { deviceInputValues } from "./device-input.ts"
import path from "node:path"
import { formatJSON } from "../util/json.ts"
import { ProfileStore } from "../device/profile/store.ts"
import { matchesDeviceType } from "../device/profile/schema.ts"
import { pythonLaunch } from "../python/launch.ts"
import { imageMime } from "../util/media.ts"
import { PermissionDeniedError, failure, failureMetadata } from "./errors.ts"
import { NamedError } from "../util/error.ts"
import { readLine, LineTimeoutError } from "../util/lines.ts"
import { create } from "../util/log.ts"
import type { Context, Result } from "./tool.ts"
import type { PyToolInfo, ToolManifest } from "./python-catalog.ts"

const log = create("python-tool")

class PyToolError extends NamedError {
  constructor(message: string, data: Record<string, unknown> = {}) {
    super("PyToolError", message, data)
  }
}

// The manifest's `devices:` gate — device TYPES that must have a loaded
// instance before the tool may run. Checked before the permission ask (never
// prompt for a doomed run).
async function missingDeviceTypes(cwd: string, manifest: PyToolInfo["manifest"]): Promise<string[]> {
  if (manifest.devices.length === 0) return []
  const robot = await ProfileStore.readManifest(cwd)
  if (!robot) return [...manifest.devices]
  const devices = await ProfileStore.listDevices(cwd)
  const loaded = devices.filter((device) => device.loaded).map((device) => device.type)
  // Richer device types satisfy their base contract (RGBD for RGB).
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
      const name = input.frame ? value.split(/[:/]/)[0]! : value
      const device = await ProfileStore.readDevice(cwd, name)
      if (!device) throw new PyToolError(`device input "${parameter}": unknown device "${name}"`)
      if (!input.types.some((type) => matchesDeviceType(device.type, type)))
        throw new PyToolError(`device input "${parameter}" accepts ${input.types.join(" | ")}; "${name}" is ${device.type}`)
      if (!device.loaded) throw new PyToolError(`device input "${parameter}": "${name}" is unloaded`)
    }
  }
}

const missingDevicesError = (name: string, missing: string[]) =>
  `tool "${name}" requires a loaded device of type ${missing.join(", ")} — none is loaded. configure an instance or /load an existing device first`

// The dialog carries invocation metadata, profiles and selected results.
// ROS payloads travel directly between Python nodes and devices.
type Request = Record<string, unknown>
type ExecutionContext = Context & { output?: (text: string) => void }
type MotionContext = ExecutionContext & { motionOwner: string }
type PythonExecution = Pick<ToolManifest, "name" | "timeout_s"> & {
  directory: string
  entry: string[]
  source?: string
  script?: { file?: string; argv: string[]; exitCode: number | null }
}

function execution(info: PyToolInfo): PythonExecution {
  const { name, timeout_s, entry } = info.manifest
  return { name, timeout_s, directory: info.directory, entry: info.manifest.async ? ["-m", "kinex.host.run", "tool", path.join(info.directory, entry)] : [path.join(info.directory, entry)] }
}

async function dispatch(cwd: string, request: Request, ctx: MotionContext): Promise<Record<string, unknown>> {
  const call = request["call"]
  if (call === "runtime_devices") {
    const devices = await ProfileStore.listDevices(cwd)
    return { ok: true, result: await Promise.all(devices.map(async device => ({
      name: device.name, type: device.type, loaded: device.loaded,
      ready: await rosReady(cwd, device),
    }))) }
  }
  if (call === "runtime_device") {
    const name = z.string().parse(request["device"])
    const device = await ProfileStore.readDevice(cwd, name)
    if (!device) return { ok: false, error: `unknown device "${name}"` }
    return { ok: true, result: { name: device.name, type: device.type, description: device.description,
      loaded: device.loaded, ready: await rosReady(cwd, device) } }
  }
  if (call === "runtime_operations") {
    const name = z.string().parse(request["device"])
    const device = await ProfileStore.readDevice(cwd, name)
    if (!device) return { ok: false, error: `unknown device "${name}"` }
    return { ok: true, result: device.operations }
  }
  if (call === "ros_enroll") {
    await enrollRos(cwd, ctx.motionOwner, z.string().parse(request["device"]))
    return { ok: true }
  }
  if (call === "stop_owned") {
    try {
      await cleanupRos(cwd, ctx.motionOwner, true)
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
    const error = modelErrors.get(device)
    if (error) return { ok: false, error }
    const model = deviceTree(device)
    return { ok: true, profile: model ? { ...device, resolved_model: model } : device }
  }
  return { ok: false, error: `unknown call "${String(call)}" — use runtime_devices, runtime_device, runtime_operations, ros_enroll, stop_owned, profile or robot` }
}

// Run the dialog to completion; preserve the returned JSON value, including null.
async function invoke(cwd: string, info: PythonExecution, args: Record<string, unknown>, ctx: ExecutionContext): Promise<unknown> {
  const motionOwner = shortID()
  const signal = AbortSignal.any([ctx.abort, AbortSignal.timeout(Math.ceil(info.timeout_s * 1000))])
  const scoped = { ...ctx, abort: signal, motionOwner }
  signal.throwIfAborted()
  const ros = await rosCatalog(cwd, motionOwner)
  const runtime = await pythonLaunch(cwd, "tool", undefined, signal)
  signal.throwIfAborted()
  const request = JSON.stringify({ args, source: info.source, file: info.script?.file, argv: info.script?.argv, ros }) + "\n"
  const proc = spawnProcess([...runtime.command, ...info.entry], {
    cwd: info.directory,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...runtime.env, KINEX_TOOL_DIALOG: "1" },
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
        const response = await abortable(dispatch(cwd, parsed, scoped), signal)
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
    // Stop owned motion before reporting the failure.
    await cleanupRos(cwd, motionOwner, true).catch(failure => { log.warn(String(failure)) })
    throw error
  })
  await cleanupRos(cwd, motionOwner, false)
  return finished
}

interface ScriptInput {
  python?: string
  file?: string
  args: Record<string, unknown>
  argv: string[]
  timeout_s: number
}

export async function runScript(input: ScriptInput, ctx: Context): Promise<Result> {
  await ctx.ask({ permission: "python_tool", description: `run Python exec ${JSON.stringify(input)}` })
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
      name: "exec", directory: ctx.directory, entry: ["-u", "-m", "kinex.host.run", "exec"],
      timeout_s: input.timeout_s, source: input.python, script,
    }, input.args, { ...ctx, output: capture })
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
  const { name } = info.manifest
  const missing = await missingDeviceTypes(cwd, info.manifest)
  if (missing.length > 0) throw new PyToolError(missingDevicesError(name, missing))
  await validateInputs(cwd, info, args)
  await ctx.ask({ permission: "python_tool", description: `run Python tool ${name} ${JSON.stringify(args)}` })
  await validateInputs(cwd, info, args)
  const returned = await invoke(cwd, execution(info), args, ctx)
  return {
    title: `${name} (Python tool)`,
    output: formatJSON(returned),
    ...await resultAttachments(returned, cwd),
  }
}

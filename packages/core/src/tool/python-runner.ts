import { rosCatalog, rosReady } from "../device/ros.ts"
import { enrollDevice, registerInvocation, releaseInvocation } from "../device/stop.ts"
import { serveProcess, terminate } from "../device/serve-process.ts"
import { spawnProcess } from "../util/process.ts"
import { abortable } from "../util/abort.ts"
import { z } from "zod"
import { pythonDiagnostic } from "../python/environment.ts"
import { deviceTree, modelErrors } from "../device/profile/urdf.ts"
import path from "node:path"
import { formatJSON } from "../util/json.ts"
import { ProfileStore } from "../device/profile/store.ts"
import { pythonLaunch } from "../python/launch.ts"
import { imageMime } from "../util/media.ts"
import { PermissionDeniedError, failure, failureMetadata } from "./errors.ts"
import { NamedError } from "../util/error.ts"
import { readLine, LineTimeoutError } from "../util/lines.ts"
import { create } from "../util/log.ts"
import type { Context, Result } from "./tool.ts"

const log = create("exec")

class ExecError extends NamedError {
  constructor(message: string, data: Record<string, unknown> = {}) {
    super("ExecError", message, data)
  }
}

// The dialog carries invocation metadata, profiles and the returned result.
// ROS payloads travel directly between Python nodes and devices.
type Request = Record<string, unknown>
type ExecutionContext = Context & { output?: (text: string) => void }
type InvocationContext = ExecutionContext & { invocation: string }
export interface ExecInput {
  python?: string
  file?: string
  program?: string
  args: Record<string, unknown>
  argv: string[]
  timeout_s: number
}
interface Returned { result: unknown; files: string[] }

async function dispatch(cwd: string, request: Request, ctx: InvocationContext): Promise<Record<string, unknown>> {
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
    await enrollDevice(cwd, ctx.invocation, z.string().parse(request["device"]))
    return { ok: true }
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
  return { ok: false, error: `unknown call "${String(call)}" — use runtime_devices, runtime_device, runtime_operations, ros_enroll, profile or robot` }
}

// Run the dialog to completion; a failure stops every device the invocation commanded.
async function invoke(cwd: string, input: ExecInput, ctx: ExecutionContext): Promise<Returned> {
  const cancel = new AbortController()
  const invocation = registerInvocation(cancel)
  let failed = true
  try {
    const result = await dialog(cwd, input, { ...ctx, invocation, abort: AbortSignal.any([ctx.abort, cancel.signal]) })
    failed = false
    return result
  } finally {
    await releaseInvocation(cwd, invocation, failed).catch(error => { log.warn(String(error)) })
  }
}

// Preserve the returned JSON value, including null; a clean exit without one returns null.
async function dialog(cwd: string, input: ExecInput, ctx: InvocationContext): Promise<Returned> {
  const signal = AbortSignal.any([ctx.abort, AbortSignal.timeout(Math.ceil(input.timeout_s * 1000))])
  const scoped = { ...ctx, abort: signal }
  signal.throwIfAborted()
  const ros = await rosCatalog(cwd)
  const runtime = await pythonLaunch(cwd, "exec", undefined, signal)
  signal.throwIfAborted()
  const request = JSON.stringify({
    args: input.args, source: input.python, file: input.file && path.resolve(cwd, input.file), program: input.program, argv: input.argv, ros,
  }) + "\n"
  const proc = spawnProcess([...runtime.command, "-u", "-m", "kinex.host.run"], {
    cwd,
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
  const deadline = Date.now() + input.timeout_s * 1000

  const conversation = (async (): Promise<Returned> => {
    for (;;) {
      const line = await abortable(readLine(source, deadline), signal).catch((error: unknown) => {
        if (error instanceof LineTimeoutError || (error instanceof Error && error.name === "TimeoutError")) throw new ExecError("exec timed out")
        throw error
      })
      if (line === undefined) {
        const code = await abortable(proc.exited, signal)
        await served.drained
        if (code === 0) return { result: null, files: [] }
        throw new ExecError(ctx.abort.aborted ? "exec interrupted" : pythonDiagnostic(`script exited with code ${code}`, runtime.executable))
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
      if ("return" in parsed) return { result: parsed["return"], files: z.array(z.string()).parse(parsed["files"]) }
      if ("error" in parsed) throw new ExecError(pythonDiagnostic(String(parsed["error"]), runtime.executable), failureMetadata(parsed))
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
    throw new ExecError(`cannot send exec request: ${error instanceof Error ? error.message : String(error)}`)
  })
  return Promise.all([sent, conversation]).then(([, result]) => result).finally(async () => {
    try {
      await terminate(served, !signal.aborted)
      await served.drained
    } finally {
      signal.removeEventListener("abort", onAbort)
    }
  }).then(result => {
    signal.throwIfAborted()
    if (proc.exitCode !== 0) throw new ExecError(`script exited with code ${proc.exitCode}`)
    return result
  })
}

export async function runExec(input: ExecInput, ctx: Context): Promise<Result> {
  await ctx.ask({ permission: "python_tool", description: `run Python exec ${JSON.stringify(input)}` })
  let output = "", dropped = 0
  const capture = (text: string) => {
    output += text
    const length = output.length
    output = output.slice(-16_384)
    // Leave room for JSON escaping and the surrounding result envelope.
    while (JSON.stringify(output).length > 16_384) output = output.slice(Math.ceil(output.length / 4))
    dropped += length - output.length
  }
  let returned: Returned | undefined, error: ReturnType<typeof failure> | undefined
  try {
    returned = await invoke(ctx.directory, input, { ...ctx, output: capture })
  } catch (caught) {
    if (caught instanceof PermissionDeniedError) throw caught
    error = failure(caught)
  }
  return {
    title: "exec (Python)",
    output: formatJSON({ output: `${dropped ? `(output truncated: ${dropped} characters dropped)\n` : ""}${output}`,
      ...(error ?? { result: returned?.result ?? null }) }),
    ...(error ? { isError: true } : await attachments(returned?.files ?? [], ctx.directory)),
  }
}

// Returned images and image paths, in the order the result names them.
async function attachments(files: string[], directory: string) {
  const found = (await Promise.all(files.map(async file => {
    const resolved = path.resolve(directory, file)
    const mime = await imageMime(resolved)
    return mime ? [{ mime, path: resolved }] : []
  }))).flat()
  return found.length ? { attachments: found } : {}
}

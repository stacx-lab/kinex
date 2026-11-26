import { rosExec } from "../device/ros.ts"
import { libRoots } from "../lib/catalog.ts"
import { enrollDevice, registerInvocation, releaseInvocation } from "../device/stop.ts"
import { abortable } from "../util/abort.ts"
import { z } from "zod"
import { pythonDiagnostic } from "../python/environment.ts"
import { deviceTree, modelErrors } from "../device/profile/urdf.ts"
import path from "node:path"
import { formatJSON } from "../util/json.ts"
import { ProfileStore } from "../device/profile/store.ts"
import { imageMime } from "../util/media.ts"
import { PermissionDeniedError, failure, failureMetadata } from "./errors.ts"
import { NamedError } from "../util/error.ts"
import { create } from "../util/log.ts"
import type { Context, Result } from "./tool.ts"
import { SubagentCall, type SubagentItem } from "./subagent.ts"

const log = create("exec")

class ExecError extends NamedError {
  constructor(message: string, data: Record<string, unknown> = {}) {
    super("ExecError", message, data)
  }
}

// The dialog carries invocation metadata, profiles and the program's result.
// ROS payloads travel directly between Python nodes and devices.
type Request = Record<string, unknown>
type ExecutionContext = Context & { output?: (text: string) => void }
type InvocationContext = ExecutionContext & { invocation: string }
export interface ExecInput {
  python?: string
  file?: string
  args: Record<string, unknown>
  argv: string[]
  timeout_s: number
}
interface Returned { result: unknown; files: string[] }

async function dispatch(cwd: string, request: Request, ctx: InvocationContext): Promise<Record<string, unknown>> {
  const call = request["call"]
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
    if (!device) return { ok: false, error: `no device "${name}" for robot ${robot.identity.id}` }
    const error = modelErrors.get(device)
    if (error) return { ok: false, error }
    const model = deviceTree(device)
    return { ok: true, profile: model ? { ...device, resolved_model: model } : device }
  }
  return { ok: false, error: `unknown call "${String(call)}" — use ros_enroll, profile, robot or subagent` }
}

// A program's question to a model. Its failures are the program's to handle, so they
// are answers, never the end of the invocation.
async function subagent(cwd: string, request: Request, ctx: InvocationContext): Promise<Record<string, unknown>> {
  const parsed = SubagentCall.safeParse(request)
  if (!parsed.success) return { ok: false, error: `invalid subagent call: ${z.prettifyError(parsed.error)}` }
  if (!ctx.subagent) return { ok: false, error: "this host runs no subagents", code: "subagent_unavailable" }
  const { instruction, model, thinking, timeout_s } = parsed.data
  const show: SubagentItem[] = []
  for (const item of parsed.data.show) {
    if (!("image" in item)) { show.push(item); continue }
    const file = path.resolve(cwd, item.image)
    const mime = await imageMime(file)
    if (!mime) return { ok: false, error: `subagent cannot be shown ${file}: it is not a readable image` }
    show.push({ name: item.name, image: { path: file, mime } })
  }
  const signal = AbortSignal.any([ctx.abort, AbortSignal.timeout(Math.ceil(timeout_s * 1000))])
  const started = Date.now()
  try {
    const reply = await abortable(ctx.subagent({ instruction, show, model: model ?? undefined, thinking: thinking ?? undefined }, signal), signal)
    // The reply decides what the program does next, so it is part of the invocation's output.
    ctx.output?.(`subagent ${reply.model} (${((Date.now() - started) / 1000).toFixed(1)} s): ${reply.text.trim()}\n`)
    return { ok: true, text: reply.text }
  } catch (error) {
    if (ctx.abort.aborted) throw error
    const message = signal.aborted ? `subagent gave no reply within ${timeout_s} s` : error instanceof Error ? error.message : String(error)
    ctx.output?.(`subagent failed: ${message}\n`)
    return { ok: false, error: message, code: "subagent_failed" }
  }
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

// What finish returned, including null; a program that ends without finish returns null. The
// program runs in the Python runtime its devices are loaded in, which serves its calls here.
async function dialog(cwd: string, input: ExecInput, ctx: InvocationContext): Promise<Returned> {
  const timeout = AbortSignal.timeout(Math.ceil(input.timeout_s * 1000))
  const signal = AbortSignal.any([ctx.abort, timeout])
  // A call the program stops waiting for ends with it.
  const ended = new AbortController()
  const scoped = { ...ctx, abort: AbortSignal.any([signal, ended.signal]) }
  signal.throwIfAborted()
  const { reply, executable } = await rosExec(cwd, {
    args: input.args, source: input.python, file: input.file && path.resolve(cwd, input.file), argv: input.argv, cwd,
    // The library roots beyond the shipped one, nearest first, as they are for this program.
    lib: (await libRoots(cwd)).slice(0, -1).map(root => root.directory),
  }, {
    // A subagent's failures are the program's to handle; its other calls are the host's own.
    call: request => request["call"] === "subagent" ? subagent(cwd, request, scoped) : dispatch(cwd, request, scoped),
    output: ctx.output,
  }, signal).catch((error: unknown) => {
    if (timeout.aborted && !ctx.abort.aborted) throw new ExecError("exec timed out")
    signal.throwIfAborted()
    throw error
  }).finally(() => ended.abort())
  if (timeout.aborted && !ctx.abort.aborted) throw new ExecError("exec timed out")
  signal.throwIfAborted()
  if ("error" in reply) throw new ExecError(pythonDiagnostic(String(reply["error"]), executable), failureMetadata(reply))
  return { result: reply["return"], files: z.array(z.string()).parse(reply["files"]) }
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
  const text = (outcome: object) =>
    formatJSON({ output: `${dropped ? `(output truncated: ${dropped} characters dropped)\n` : ""}${output}`, ...outcome })
  try {
    const { result, files } = await invoke(ctx.directory, input, { ...ctx, output: capture })
    // The files finish named, in its order; those that are images are attached.
    const attachments = (await Promise.all(files.map(async file => {
      const resolved = path.resolve(ctx.directory, file)
      const mime = await imageMime(resolved)
      return mime ? [{ mime, path: resolved }] : []
    }))).flat()
    return { title: "exec (Python)", output: text({ result, ...(files.length ? { file: files } : {}) }), ...(attachments.length ? { attachments } : {}) }
  } catch (caught) {
    if (caught instanceof PermissionDeniedError) throw caught
    return { title: "exec (Python)", output: text(failure(caught)), isError: true }
  }
}

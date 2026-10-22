import { scoped, currentScope, currentSignal } from "../scope.ts"
import { abortable } from "../util/abort.ts"
import { pythonRuntime } from "../python/environment.ts"
import { spawnProcess } from "../util/process.ts"
import { readFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { hasMissing } from "./profile/common.ts"
import path from "node:path"
import { Assets } from "../installation/assets.ts"
import { NamedError } from "../util/error.ts"
import type { Device } from "./profile/schema.ts"
import { jointConfigurationErrors, ResolvedJointModel, resolvedJointModels, jointModelErrors } from "./profile/joint.ts"
import { handJointErrors } from "./profile/hand.ts"
import { gripErrors } from "./profile/gripper.ts"
import { UrdfTree, resolvedTrees } from "./profile/urdf.ts"

const models = scoped(() => new Map<string, Promise<unknown>>())

// A chain from base to tip, or the whole tree below base when tip is omitted.
async function introspect(directory: string, file: string, base: string, tip?: string): Promise<unknown> {
  const signal = currentSignal()
  signal?.throwIfAborted()
  const xml = await readFile(file, "utf8")
  signal?.throwIfAborted()
  const key = JSON.stringify([directory, file, base, tip, createHash("sha256").update(xml).digest("hex")])
  const cached = models().get(key)
  if (cached) return abortable(cached, signal)
  // Parsing is shared by callers in this runtime. Only disposal cancels the
  // shared work; an invocation's cancellation releases its own waiter.
  const ownerSignal = currentScope().signal ?? new AbortController().signal
  const pending = (async () => {
    const runtime = await pythonRuntime(directory, undefined, ownerSignal)
    const proc = spawnProcess([runtime.executable, Assets.python("introspect_urdf.py"), "--urdf", file,
      "--base-link", base, ...(tip ? ["--tip-link", tip] : []), "--stdin"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: runtime.env, signal: ownerSignal })
    proc.stdin.write(xml)
    proc.stdin.end()
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    if (code !== 0) throw new NamedError("JointModelError", err.trim())
    return JSON.parse(out) as unknown
  })()
  models().set(key, pending)
  void pending.catch(() => {
    if (models().get(key) === pending) models().delete(key)
  })
  if (models().size > 64) {
    const oldest = models().keys().next().value
    if (oldest !== undefined) models().delete(oldest)
  }
  return abortable(pending, signal)
}

export async function urdfModel(directory: string, file: string, base: string, tip: string): Promise<ResolvedJointModel> {
  return ResolvedJointModel.parse(await introspect(directory, file, base, tip))
}

async function resolve(device: Device, directory: string): Promise<Device> {
  if (device.type === "gripper") {
    const spec = device.model
    if (spec === "???" || hasMissing(spec)) return device
    const tree = UrdfTree.parse(await introspect(directory, path.resolve(directory, spec.path), spec.base_link))
    const errors = gripErrors(device, tree)
    if (errors.length) throw new NamedError("JointModelError", `${device.name}: ${errors.join("; ")}`)
    resolvedTrees.set(spec, tree)
    return device
  }
  if (device.type !== "joint" && device.type !== "dexterous_hand") return device
  const modelSpec = device.model
  if (modelSpec === "???" || modelSpec.format !== "urdf" || hasMissing(modelSpec)) return device
  const model = await urdfModel(directory, path.resolve(directory, modelSpec.path), modelSpec.base_link, modelSpec.tip_link)
  const errors = jointConfigurationErrors(device, model)
  if (device.type === "dexterous_hand") errors.push(...handJointErrors(device.geometry, model))
  if (errors.length) throw new NamedError("JointModelError", `${device.name}: ${errors.join("; ")}`)
  resolvedJointModels.set(modelSpec, model)
  return device
}

// Invalid model resources block calibration/motion, but never hide a stop path.
// Writes validate strictly before saving; reads retain the device and its error.
export function resolveJoint(device: Device, directory: string, strict = false): Promise<Device> {
  return resolve(device, directory).catch((error: unknown) => {
    if (strict) throw error
    if (["joint", "dexterous_hand", "gripper"].includes(device.type)) jointModelErrors.set(device, error instanceof Error ? error.message : String(error))
    return device
  })
}

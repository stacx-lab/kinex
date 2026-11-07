import { scoped, currentScope, currentSignal } from "../scope.ts"
import { abortable } from "../util/abort.ts"
import { pythonRuntime } from "../python/environment.ts"
import { spawnProcess } from "../util/process.ts"
import { readFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import path from "node:path"
import { z } from "zod"
import { Assets } from "../installation/assets.ts"
import { NamedError } from "../util/error.ts"
import type { Device } from "./profile/schema.ts"
import { jointErrors } from "./profile/joint.ts"
import { gripErrors } from "./profile/gripper.ts"
import { frameErrors } from "./profile/frames.ts"
import { UrdfTree, deviceTree, modelErrors, resolvedTrees, urdfSpec } from "./profile/urdf.ts"

const trees = scoped(() => new Map<string, Promise<UrdfTree>>())

// Run a kinex.host.urdf command in Kinex Python; it reads input on stdin and prints JSON.
async function urdf(directory: string, args: string[], input: string, signal?: AbortSignal): Promise<unknown> {
  const runtime = await pythonRuntime(directory, undefined, signal)
  const env = { ...runtime.env, PYTHONPATH: [Assets.python(), runtime.env.PYTHONPATH].filter(Boolean).join(path.delimiter) }
  const proc = spawnProcess([runtime.executable, "-m", "kinex.host.urdf", ...args], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env, signal })
  proc.stdin.write(input)
  proc.stdin.end()
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  if (code !== 0) throw new NamedError("DeviceModelError", err.trim())
  return JSON.parse(out)
}

// The URDF tree below base, parsed once per runtime for each file content.
export async function urdfTree(directory: string, file: string, base: string): Promise<UrdfTree> {
  const signal = currentSignal()
  signal?.throwIfAborted()
  const xml = await readFile(file, "utf8")
  signal?.throwIfAborted()
  const key = JSON.stringify([directory, file, base, createHash("sha256").update(xml).digest("hex")])
  const cached = trees().get(key)
  if (cached) return abortable(cached, signal)
  // Parsing is shared by callers in this runtime. Only disposal cancels the
  // shared work; an invocation's cancellation releases its own waiter.
  const ownerSignal = currentScope().signal ?? new AbortController().signal
  const pending = urdf(directory, ["tree", base], xml, ownerSignal).then(tree => UrdfTree.parse(tree))
  trees().set(key, pending)
  void pending.catch(() => {
    if (trees().get(key) === pending) trees().delete(key)
  })
  if (trees().size > 64) {
    const oldest = trees().keys().next().value
    if (oldest !== undefined) trees().delete(oldest)
  }
  return abortable(pending, signal)
}

// The pose [x, y, z, qx, qy, qz, qw] of a URDF link in <device>/base at measured joint positions.
export async function linkPose(directory: string, device: Device, link: string, positions: Record<string, number>, signal = currentSignal()): Promise<number[]> {
  const tree = deviceTree(device)
  if (!tree) throw new NamedError("DeviceModelError", modelErrors.get(device) ?? `${device.name} has no resolved URDF`)
  return z.array(z.number()).length(7).parse(await urdf(directory, ["pose"], JSON.stringify({ tree, link, positions }), signal))
}

// A resolved tree also completes frame validation: parents may name URDF links.
async function resolve(device: Device, directory: string): Promise<Device> {
  const spec = urdfSpec(device)
  if (!spec || (device.type !== "joint" && device.type !== "gripper")) return device
  const tree = await urdfTree(directory, path.resolve(directory, spec.path), spec.base_link)
  resolvedTrees.set(spec, tree)
  const errors = [...frameErrors([device], false), ...device.type === "joint" ? jointErrors(device, tree) : gripErrors(device, tree)]
  if (!errors.length) return device
  resolvedTrees.delete(spec)
  throw new NamedError("DeviceModelError", `${device.name}: ${errors.join("; ")}`)
}

// Invalid model resources block calibration/motion, but never hide a stop path.
// Writes validate strictly before saving; reads retain the device and its error.
export function resolveDeviceModel(device: Device, directory: string, strict = false): Promise<Device> {
  return resolve(device, directory).catch((error: unknown) => {
    if (strict) throw error
    modelErrors.set(device, error instanceof Error ? error.message : String(error))
    return device
  })
}

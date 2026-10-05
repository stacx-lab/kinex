import path from "node:path"
import { readdir, mkdir, copyFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import { spawnProcess } from "@kinex/core/util/process"
import { pythonRuntime } from "@kinex/core/python/environment"
import { Assets as CoreAssets } from "@kinex/core/installation/assets"
import { ProfileStore } from "@kinex/core/device/profile/store"
import { getRoutine } from "./routines/index.ts"
import { AttemptInput, attempt, archive, saveAttempt } from "./attempt.ts"
import { procedures } from "../planning/procedures.ts"
import { atomicJSON, fail, location, inspectFacts } from "../planning/facts.ts"
import { Assets } from "../assets.ts"
import { serialized } from "../planning/plan.ts"
import { withSignal } from "@kinex/core/scope"

const common = { ...AttemptInput.shape, interpreter: z.string().optional(), timeout_s: z.number().positive().max(600).default(120) }
const file = z.string().min(1).describe("Input file path, relative to invocation directory or absolute")
export const ComputeInput = z.discriminatedUnion("operation", [
  z.strictObject({ ...common, operation: z.literal("urdf-introspect") }),
  z.strictObject({ ...common, operation: z.literal("fit-mount"), points: file, parent_frame: z.string().min(1) }),
  z.strictObject({ ...common, operation: z.literal("fit-dual"), points: file }),
  z.strictObject({ ...common, operation: z.literal("fit-tcp"), samples: file, frame: z.string().default("flange") }),
  z.strictObject({ ...common, operation: z.literal("camera-extrinsics"), samples: file,
    mode: z.enum(["eye_in_hand", "eye_to_hand"]), frame: z.string().default("flange") }),
  z.strictObject({ ...common, operation: z.literal("camera-intrinsics"), images: z.array(file).min(10),
    board: z.enum(["charuco", "checkerboard"]).default("charuco"), square_mm: z.number().positive(),
    marker_mm: z.number().positive().optional(), squares_x: z.number().int().min(2).default(7), squares_y: z.number().int().min(2).default(5),
    corners_x: z.number().int().min(2).default(9), corners_y: z.number().int().min(2).default(6), dictionary: z.string().default("DICT_4X4_50") }),
  z.strictObject({ ...common, operation: z.literal("verify-base"), measurements: file }),
])
export type ComputeInput = z.infer<typeof ComputeInput>
const scripts = {
  "fit-mount": ["calibrate-fixed-arm-mount", "fit_mount.py"],
  "fit-dual": ["calibrate-dual-arm", "fit_dual.py"],
  "fit-tcp": ["calibrate-tcp-offset", "fit_tcp.py"],
  "camera-extrinsics": ["calibrate-camera-extrinsics", "solve_extrinsics.py"],
  "camera-intrinsics": ["calibrate-camera-intrinsics", "calibrate_intrinsics.py"],
} as const
const output = z.record(z.string(), z.unknown())
const number = (data: Record<string, unknown>, key: string) => z.number().finite().parse(data[key])
export function quality(operation: ComputeInput["operation"], data: Record<string, unknown>): "passed" | "warning" | "failed" | "not-evaluated" {
  if (data.ok === false) return "failed"
  if (operation === "urdf-introspect") return "not-evaluated"
  if (operation === "fit-mount" || operation === "fit-dual" || operation === "verify-base")
    return data.quality_pass === true ? "passed" : "failed"
  if (operation === "fit-tcp") {
    const residual = number(data, "residual_mm")
    return number(data, "n") < 4 || residual > 10 ? "failed" : residual < 5 ? "passed" : "warning"
  }
  if (operation === "camera-extrinsics") return number(data, "pairs_used") >= 5 && number(data, "residual_rot_deg") <= 2 &&
    number(data, "residual_trans_mm") <= 10 ? "passed" : "failed"
  const rms = number(data, "rms_px")
  if (rms > 1 || number(data, "frames_used") < 10) return "failed"
  return rms >= .5 || z.array(z.string()).parse(data.coverage_warnings).length ? "warning" : "passed"
}
export async function compute(cwd: string, input: ComputeInput, abort: AbortSignal) {
  const key = await location(cwd, `calib/${input.run ?? randomUUID()}`)
  return serialized(key, () => executeCompute(cwd, input, abort))
}
async function executeCompute(cwd: string, input: ComputeInput, abort: AbortSignal) {
  abort.throwIfAborted()
  const args = ComputeInput.parse(input)
  const run = await attempt(cwd, args)
  const descriptor = (await procedures(cwd)).find(skill => skill.name === run.procedure)?.descriptor
  if (!descriptor?.computes.includes(args.operation)) fail(`${run.procedure} does not declare ${args.operation}; custom scripts use host tools`)
  const directory = await saveAttempt(cwd, run)
  const signal = AbortSignal.any([abort, AbortSignal.timeout(Math.ceil(args.timeout_s * 1000))])
  let data: Record<string, unknown>
  if (args.operation === "urdf-introspect") {
    const robot = await ProfileStore.readManifest(cwd)
    if (!robot) fail("Create the workspace manifest first")
    const result = await withSignal(signal, () => getRoutine("urdf-introspect")!.run({ cwd, robot, deviceID: run.bindings.arm }))
    data = { ok: result.status === "ok", model: result.data, notes: result.notes }
  } else {
    const archived = async (file: string) => archive(cwd, run, path.resolve(cwd, file))
    const argv: string[] = []
    if (args.operation === "fit-mount" || args.operation === "fit-dual") argv.push("--points", await archived(args.points))
    if (args.operation === "fit-tcp") argv.push("--samples", await archived(args.samples), "--frame", args.frame)
    if (args.operation === "camera-extrinsics") argv.push("--samples", await archived(args.samples), "--mode", args.mode,
      "--device", run.bindings.arm ?? fail("Bind arm"), "--frame", args.frame)
    if (args.operation === "verify-base") argv.push("--measurements", await archived(args.measurements))
    if (args.operation === "camera-intrinsics") {
      // A distinct image directory avoids mixing previous solves or other artifacts.
      const images = path.join(directory, "artifacts", randomUUID())
      await mkdir(images)
      for (const [index, image] of args.images.entries()) await copyFile(path.resolve(cwd, image), path.join(images, `${index}${path.extname(image)}`))
      argv.push("--images", path.join(images, "*"), "--board", args.board, "--square-mm", String(args.square_mm),
        "--squares-x", String(args.squares_x), "--squares-y", String(args.squares_y),
        "--corners-x", String(args.corners_x), "--corners-y", String(args.corners_y), "--dict", args.dictionary)
      if (args.marker_mm !== undefined) argv.push("--marker-mm", String(args.marker_mm))
    }
    // Only bundled, known offline programs execute here. Overriding skill prose
    // does not grant permission to execute arbitrary replacement Python.
    const script = args.operation === "verify-base" ? path.join(Assets.root, "compute", "verify_base.py") :
      path.join(Assets.builtin("skill"), scripts[args.operation][0], "scripts", scripts[args.operation][1])
    const python = await pythonRuntime(cwd, args.interpreter, signal)
    const library = CoreAssets.python()
    const proc = spawnProcess([python.executable, script, ...argv], { cwd: directory, signal, group: true,
      env: { ...python.env, PYTHONPATH: [library, await location(cwd, "lib"), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) } })
    proc.stdin.end()
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    signal.throwIfAborted()
    try { data = output.parse(JSON.parse(stdout)) } catch (error) {
      if (code === 0) throw error
      data = { ok: false, error: stderr.trim() || `Solver exited ${code}` }
    }
    if (code !== 0) data = { ...data, ok: false }
  }
  signal.throwIfAborted()
  if ((await inspectFacts(cwd, run.inputs)).hash !== run.fingerprint) fail("Inputs changed during computation; start a new attempt")
  const assessment = quality(args.operation, data)
  const patches: { kind: "device"; data: Record<string, unknown> }[] = []
  const resolved: { device: string; pointer: string; value: unknown }[] = []
  const target = run.bindings.target ?? run.bindings.second
  if (assessment !== "failed" && target) {
    const measured = { source: "calibration", calibrated_at: new Date().toISOString() }
    if (args.operation === "camera-intrinsics") {
      const color = { width: data.width, height: data.height, projection: data.projection, distortion: data.distortion }
      patches.push({ kind: "device", data: { name: target, intrinsics: { ...measured, method: args.board, color } } })
      for (const [field, value] of Object.entries(color)) resolved.push({ device: target, pointer: `/intrinsics/color/${field}`, value })
    } else if (["fit-mount", "fit-dual", "fit-tcp", "camera-extrinsics"].includes(args.operation)) {
      const parent = run.bindings.parent ?? run.bindings.anchor ?? run.bindings.arm ?? fail("Bind parent, anchor or arm")
      const frame = args.operation === "fit-mount" ? args.parent_frame : args.operation === "fit-dual" ? parent :
        args.operation === "camera-extrinsics" && args.mode === "eye_to_hand" ? parent : "frame" in args ? args.frame : parent
      const translation = args.operation === "fit-tcp" ? data.tcp_translation_m : data.translation_m
      const mount = { parent, parent_frame: frame, translation_m: translation,
        ...(args.operation === "fit-tcp" ? {} : { rotation_xyzw: data.rotation_xyzw }) }
      patches.push({ kind: "device", data: { name: target, extrinsics: { ...measured,
        method: args.operation === "fit-tcp" ? "tcp_pivot" : args.operation === "camera-extrinsics" ? "hand_eye" : "survey", mount } } })
      for (const [field, value] of Object.entries(mount)) resolved.push({ device: target, pointer: `/extrinsics/mount/${field}`, value })
    }
  }
  const result = { version: 1, run: run.id, node: run.node, procedure: run.procedure, operation: args.operation,
    computation: data.ok === false ? "failed" : "succeeded", quality: assessment, data, resolved,
    unresolved: args.operation === "fit-tcp" ? ["TCP orientation is not measured by pivot calibration"] : [],
    proposedChanges: patches, inputs: run.inputs, fingerprint: run.fingerprint, dependencies: run.dependencies, createdAt: new Date().toISOString() }
  signal.throwIfAborted()
  // Keep each solve and its artifacts; result.json is only the latest view.
  const indexes = (await readdir(directory)).flatMap(name => {
    const match = /^result-(\d+)\.json$/.exec(name)
    return match ? [Number(match[1])] : []
  })
  const count = Math.max(-1, ...indexes) + 1
  await atomicJSON(path.join(directory, `result-${count}.json`), result)
  await atomicJSON(path.join(directory, "result.json"), result)
  return { ...result, evidence: `calib/${run.id}/result-${count}.json` }
}

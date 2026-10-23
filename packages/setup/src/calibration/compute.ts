import { shortID } from "@kinex/core/util/id"
import path from "node:path"
import { readdir, readFile, mkdir, copyFile } from "node:fs/promises"
import { z } from "zod"
import { spawnProcess } from "@kinex/core/util/process"
import { pythonLaunch } from "@kinex/core/python/launch"
import { ProfileStore } from "@kinex/core/device/profile/store"
import { deviceFrames } from "@kinex/core/device/profile/frames"
import { deviceTree, modelErrors } from "@kinex/core/device/profile/urdf"
import { known } from "@kinex/core/device/profile/schema"
import { AttemptInput, attempt, archive, saveAttempt, type Attempt } from "./attempt.ts"
import { procedures } from "../planning/procedures.ts"
import { atomicJSON, fail, location, inspectFacts } from "../planning/facts.ts"
import { Assets } from "../assets.ts"
import { serialized } from "../planning/plan.ts"

const common = { ...AttemptInput.shape, timeout_s: z.number().positive().max(600).default(120) }
const file = z.string().min(1).describe("Input file path, relative to invocation directory or absolute")
const frame = z.string().min(1).describe("URDF link whose poses the samples hold")
export const ComputeInput = z.discriminatedUnion("operation", [
  z.strictObject({ ...common, operation: z.literal("urdf-introspect") }),
  z.strictObject({ ...common, operation: z.literal("fit-mount"), points: file, parent_frame: z.string().min(1) }),
  z.strictObject({ ...common, operation: z.literal("fit-dual"), points: file }),
  z.strictObject({ ...common, operation: z.literal("fit-tcp"), samples: file, frame }),
  z.strictObject({ ...common, operation: z.literal("camera-extrinsics"), samples: file,
    mode: z.enum(["eye_in_hand", "eye_to_hand"]), frame }),
  z.strictObject({ ...common, operation: z.literal("camera-intrinsics"), images: z.array(file).min(10),
    board: z.enum(["charuco", "checkerboard"]).default("charuco"), square_mm: z.number().positive(),
    marker_mm: z.number().positive().optional(), squares_x: z.number().int().min(2).default(7), squares_y: z.number().int().min(2).default(5),
    corners_x: z.number().int().min(2).default(9), corners_y: z.number().int().min(2).default(6), dictionary: z.string().default("DICT_4X4_50") }),
  z.strictObject({ ...common, operation: z.literal("verify-base"), measurements: file }),
  z.strictObject({ ...common, operation: z.literal("sensor-bias"), samples: file,
    gravity_m_s2: z.tuple([z.number(), z.number(), z.number()]).optional()
      .describe("expected static specific force in the IMU frame, e.g. [0, 0, 9.80665] when level with +z up") }),
])
export type ComputeInput = z.infer<typeof ComputeInput>
type Operation = ComputeInput["operation"]
type Inputs = { [O in Operation]: Extract<ComputeInput, { operation: O }> }
type Data = Record<string, unknown>
type Quality = "passed" | "warning" | "failed" | "not-evaluated"
interface Context { cwd: string; run: Attempt; directory: string; signal: AbortSignal }
// Calibrated facts a solve proposes for the bound target, with the pointers they resolve.
interface Facts { method: string; patch: Data; resolved: [string, unknown][] }
interface Solver<O extends Operation> {
  solve(input: Inputs[O], context: Context): Promise<Data>
  quality(data: Data): Quality
  facts?(input: Inputs[O], data: Data, target: string, context: Context): Promise<Facts>
  unresolved?: string[]
}

const output = z.record(z.string(), z.unknown())
const number = (data: Data, key: string) => z.number().finite().parse(data[key])
const passed = (data: Data): Quality => data.quality_pass === true ? "passed" : "failed"
const skillScript = (skill: string, name: string) => path.join(Assets.builtin("skill"), skill, "scripts", name)
const computeScript = (name: string) => path.join(Assets.root, "compute", name)
const archived = (context: Context, file: string) => archive(context.cwd, context.run, path.resolve(context.cwd, file))

// Only bundled, known offline programs execute here, in Kinex Python. Overriding
// skill prose does not grant permission to execute replacement Python.
async function script(file: string, argv: string[], { cwd, directory, signal }: Context): Promise<Data> {
  const python = await pythonLaunch(cwd, "node", undefined, signal)
  const proc = spawnProcess([...python.command, file, ...argv], { cwd: directory, signal, group: true, env: python.env })
  proc.stdin.end()
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  signal.throwIfAborted()
  let data: Data
  try { data = output.parse(JSON.parse(stdout)) } catch (error) {
    if (code === 0) throw error
    return { ok: false, error: stderr.trim() || `Solver exited ${code}` }
  }
  return code === 0 ? data : { ...data, ok: false }
}

const rigid = (source: string, target: string) => async (input: { points: string }, context: Context) =>
  script(computeScript("fit_rigid.py"), ["--points", await archived(context, input.points), "--source", source, "--target", target], context)

// Bias channels: where each reading sits in a sample and what a static, unloaded
// sensor should read. The node already subtracts the profile bias, so the mean
// residual is added to it. Static averaging cannot separate a magnetic field from
// its bias, so magnetometers are not calibrated here.
const BIAS_CHANNELS = {
  imu: { angular_velocity: ["angular_velocity"], linear_acceleration: ["linear_acceleration"] },
  force_torque: { force: ["wrench", "force"], torque: ["wrench", "torque"] },
} as const
const Samples = z.array(z.object({ device: z.string(), data: z.record(z.string(), z.unknown()) })).min(1)
const AXES = ["x", "y", "z"] as const
function reading(data: unknown, path: readonly string[], axis: string): number | undefined {
  const value = [...path, axis].reduce<unknown>((node, key) => node && typeof node === "object" ? Reflect.get(node, key) : undefined, data)
  return typeof value === "number" ? value : undefined
}

async function sensorBias(input: Inputs["sensor-bias"], context: Context): Promise<Data> {
  const name = context.run.bindings.target ?? fail("Bind target")
  const device = await ProfileStore.readDevice(context.cwd, name)
  if (device?.type !== "imu" && device?.type !== "force_torque") fail("Bias calibration needs an imu or force_torque target")
  const measurement: Record<string, unknown> = known(device.measurement) ? device.measurement : fail("Record the measured channels first")
  const samples = Samples.parse(JSON.parse(await readFile(await archived(context, input.samples), "utf8"))).filter(sample => sample.device === name)
  const channels: Data = {}
  for (const [channel, path] of Object.entries(BIAS_CHANNELS[device.type])) {
    const spec = z.object({ axes: z.array(z.enum(AXES)), bias: z.record(z.string(), z.number()), quantity: z.string().optional() })
      .safeParse(measurement[channel]).data
    if (!spec) continue
    const expected = channel === "linear_acceleration" && spec.quantity !== "gravity_removed"
      ? input.gravity_m_s2 ?? fail("specific-force accelerometers need gravity_m_s2, the expected static reading in the IMU frame")
      : [0, 0, 0]
    const axes = spec.axes.map(axis => {
      const values = samples.flatMap(sample => reading(sample.data, path, axis) ?? [])
      if (!values.length) fail(`no ${channel}.${axis} readings from ${name}`)
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length
      const std = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length)
      const residual = mean - expected[AXES.indexOf(axis)]!
      return [axis, { n: values.length, mean, std, residual, bias: spec.bias[axis]! + residual }] as const
    })
    channels[channel] = Object.fromEntries(axes)
  }
  if (!Object.keys(channels).length) fail(`${name} declares no channel with a recorded bias to calibrate`)
  return { ok: true, n: samples.length, channels }
}

// A measured mount of the target in a frame of its bound parent.
function mount(method: string, frame: string, data: Data, { run }: Context): Facts {
  const parent = run.bindings.parent ?? run.bindings.anchor ?? run.bindings.arm ?? fail("Bind parent, anchor or arm")
  const base = { parent: `${parent}:${frame}`, translation_m: data.translation_m, rotation_xyzw: data.rotation_xyzw }
  return { method, patch: { frames: { base } }, resolved: Object.entries(base).map(([field, value]) => [`/frames/base/${field}`, value]) }
}

const SOLVERS: { [O in Operation]: Solver<O> } = {
  "urdf-introspect": {
    async solve(_, { cwd, run }) {
      const device = await ProfileStore.readDevice(cwd, run.bindings.arm ?? run.bindings.target ?? fail("Bind arm or target"))
      if (device?.type !== "joint" && device?.type !== "gripper") return { ok: false, notes: "URDF models belong to joint and gripper devices" }
      const model = deviceTree(device)
      if (!model) return { ok: false, notes: modelErrors.get(device) ?? "record this device's URDF path and base_link first" }
      return { ok: true, model, notes: `resolved ${model.links.length} links and ${model.joints.length} joints; profile retains the URDF reference` }
    },
    quality: () => "not-evaluated",
  },
  "fit-mount": {
    solve: rigid("arm_points_m", "parent_points_m"), quality: passed,
    facts: async (input, data, _, context) => mount("survey", input.parent_frame, data, context),
  },
  "fit-dual": {
    solve: rigid("second_points_m", "anchor_points_m"), quality: passed,
    facts: async (_, data, __, context) => mount("survey", "base", data, context),
  },
  "fit-tcp": {
    async solve(input, context) {
      const target = await ProfileStore.readDevice(context.cwd, context.run.bindings.target ?? fail("Bind target"))
      const base = target ? deviceFrames(target).base : undefined
      if (!base || base.parent !== `${context.run.bindings.arm}:${input.frame}` ||
          base.translation_m === null || base.rotation_xyzw === null) fail("TCP fitting requires a known mount in the sampled arm frame")
      return script(skillScript("calibrate-tcp-offset", "fit_tcp.py"),
        ["--samples", await archived(context, input.samples), "--frame", input.frame, "--mount", JSON.stringify(base)], context)
    },
    quality(data) {
      const residual = number(data, "residual_mm")
      return number(data, "n") < 4 || residual > 10 ? "failed" : residual < 5 ? "passed" : "warning"
    },
    async facts(_, data, target, { cwd }) {
      const profile = await ProfileStore.readDevice(cwd, target)
      const tcp = profile?.type === "gripper" || profile?.type === "suction" ? profile.frames.tcp : undefined
      if (tcp && tcp.parent !== `${target}:base`) fail("TCP fitting requires tcp to be relative to the end-effector base")
      const frame = { parent: `${target}:base`, translation_m: data.tcp_translation_m, rotation_xyzw: tcp?.rotation_xyzw ?? null }
      return { method: "tcp_pivot", patch: { frames: { tcp: frame } }, resolved: [["/frames/tcp/translation_m", frame.translation_m]] }
    },
    unresolved: ["TCP orientation is not measured by pivot calibration"],
  },
  "camera-extrinsics": {
    async solve(input, context) {
      return script(skillScript("calibrate-camera-extrinsics", "solve_extrinsics.py"), ["--samples", await archived(context, input.samples),
        "--mode", input.mode, "--device", context.run.bindings.arm ?? fail("Bind arm"), "--frame", input.frame], context)
    },
    quality: data => number(data, "pairs_used") >= 5 && number(data, "residual_rot_deg") <= 2 &&
      number(data, "residual_trans_mm") <= 10 ? "passed" : "failed",
    facts: async (input, data, _, context) => mount("hand_eye", input.mode === "eye_to_hand" ? "base" : input.frame, data, context),
  },
  "camera-intrinsics": {
    async solve(input, context) {
      // A distinct image directory keeps this solve's inputs apart from other artifacts.
      const images = path.join(context.directory, "artifacts", shortID())
      await mkdir(images)
      const copies = await Promise.all(input.images.map(async (image, index) => {
        const copy = path.join(images, `${index}${path.extname(image)}`)
        await copyFile(path.resolve(context.cwd, image), copy)
        return copy
      }))
      return script(skillScript("calibrate-camera-intrinsics", "calibrate_intrinsics.py"), ["--images", ...copies,
        "--board", input.board, "--square-mm", String(input.square_mm), "--squares-x", String(input.squares_x),
        "--squares-y", String(input.squares_y), "--corners-x", String(input.corners_x), "--corners-y", String(input.corners_y),
        "--dict", input.dictionary, ...(input.marker_mm === undefined ? [] : ["--marker-mm", String(input.marker_mm)])], context)
    },
    quality(data) {
      const rms = number(data, "rms_px")
      if (rms > 1 || number(data, "frames_used") < 10) return "failed"
      return rms >= .5 || z.array(z.string()).parse(data.coverage_warnings).length ? "warning" : "passed"
    },
    async facts(input, data) {
      const color = { width: data.width, height: data.height, projection: data.projection, distortion: data.distortion }
      return { method: input.board, patch: { color }, resolved: Object.entries(color).map(([field, value]) => [`/color/${field}`, value]) }
    },
  },
  "verify-base": {
    solve: async (input, context) => script(computeScript("verify_base.py"), ["--measurements", await archived(context, input.measurements)], context),
    quality: passed,
  },
  "sensor-bias": {
    solve: sensorBias,
    quality: data => number(data, "n") >= 20 ? "passed" : "failed",
    async facts(_, data) {
      const channels = z.record(z.string(), z.record(z.string(), z.object({ bias: z.number() }))).parse(data.channels)
      const bias = Object.fromEntries(Object.entries(channels).map(([channel, axes]) =>
        [channel, Object.fromEntries(Object.entries(axes).map(([axis, value]) => [axis, value.bias]))]))
      return { method: "bias", patch: { measurement: Object.fromEntries(Object.entries(bias).map(([channel, value]) => [channel, { bias: value }])) },
        resolved: Object.entries(bias).map(([channel, value]) => [`/measurement/${channel}/bias`, value]) }
    },
  },
}

export function quality(operation: Operation, data: Data): Quality {
  return data.ok === false ? "failed" : SOLVERS[operation].quality(data)
}

export async function compute(cwd: string, input: ComputeInput, abort: AbortSignal) {
  const key = await location(cwd, `calib/${input.run ?? shortID()}`)
  return serialized(key, () => executeCompute(cwd, input, abort))
}

async function solve<O extends Operation>(operation: O, input: Inputs[O], context: Context) {
  const solver: Solver<O> = SOLVERS[operation]
  const data = await solver.solve(input, context)
  context.signal.throwIfAborted()
  if ((await inspectFacts(context.cwd, context.run.inputs)).hash !== context.run.fingerprint) fail("Inputs changed during computation; start a new attempt")
  const assessment = data.ok === false ? "failed" : solver.quality(data)
  const target = context.run.bindings.target ?? context.run.bindings.second
  const facts = assessment !== "failed" && target && solver.facts ? await solver.facts(input, data, target, context) : undefined
  return { data, assessment, target, facts, unresolved: solver.unresolved ?? [] }
}

async function executeCompute(cwd: string, input: ComputeInput, abort: AbortSignal) {
  abort.throwIfAborted()
  const args = ComputeInput.parse(input)
  const run = await attempt(cwd, args)
  const descriptor = (await procedures(cwd)).find(skill => skill.name === run.procedure)?.descriptor
  if (!descriptor?.computes.includes(args.operation)) fail(`${run.procedure} does not declare ${args.operation}; custom scripts use host tools`)
  const directory = await saveAttempt(cwd, run)
  const signal = AbortSignal.any([abort, AbortSignal.timeout(Math.ceil(args.timeout_s * 1000))])
  const { data, assessment, target, facts, unresolved } = await solve(args.operation, args, { cwd, run, directory, signal })
  const measured = { source: "calibration", calibrated_at: new Date().toISOString() }
  const result = { version: 1, run: run.id, node: run.node, procedure: run.procedure, operation: args.operation,
    computation: data.ok === false ? "failed" : "succeeded", quality: assessment, data,
    resolved: facts ? facts.resolved.map(([pointer, value]) => ({ device: target, pointer, value })) : [], unresolved,
    proposedChanges: facts ? [{ kind: "device", data: { name: target, ...measured, method: facts.method, ...facts.patch } }] : [],
    inputs: run.inputs, fingerprint: run.fingerprint, dependencies: run.dependencies, createdAt: new Date().toISOString() }
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

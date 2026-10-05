import { Mount, Transform, LocalFrame, ControlConnection } from "./common.ts"
import { ModelConnection, modelShape } from "./model.ts"
import { perceptionOperations } from "./perception.ts"
import { imuShape } from "./imu.ts"
import { SensorConnection } from "./sensor.ts"
import { z } from "zod"
import { ForceTorqueConnection, forceTorqueShape } from "./force-torque.ts"
import { worldShape, type WorkspaceBounds } from "./world.ts"
export { WorkspaceBounds, Surface } from "./world.ts"
import { VelocityControl, VelocityFeedback, VelocityStop } from "./velocity.ts"
import { gripperShape, suctionShape } from "./gripper.ts"
import { jointShape, refineJoint, jointModel } from "./joint.ts"
import { HandGeometry, refineHand } from "./hand.ts"
import { deviceFrames, modelFrames } from "./frames.ts"
import { CameraCalibration, CameraColor, CameraConnection, CameraDepth } from "./camera.ts"

import { MISSING, may, known, Source, section, measured, OtherConnection, DriverSpec, driverWith, observationActions, streamActions, actuatedActions } from "./common.ts"
export { MISSING, known, Source, DriverSpec } from "./common.ts"

// Device profiles own access, intrinsic facts and parent-relative SI mounts.
// Explicit calibration requests persist until cleared by a validated write.

const Aabb = z.object({
  min: z.tuple([z.number(), z.number(), z.number()]),
  max: z.tuple([z.number(), z.number(), z.number()]),
})

export const DeviceType = z.enum([
  "velocity",
  "dexterous_hand",
  "suction",
  "joint",
  "gripper",
  "rgb",
  "rgbd",
  "imu",
  "force_torque",
  "model",
  "detection",
  "segmentation",
  "world",
  "other",
])
export type DeviceType = z.infer<typeof DeviceType>

// One device-local command dimension. Joint targets use model order; mobile
// Bases use mode-qualified velocity/posture fields for capability display, not one command vector.
export const DeviceAction = z.object({
  component: z.string().optional().describe('non-joint dim: "grip", "locomotion.velocity.vx", "locomotion.posture.height", ...'),
  joint: z.string().optional().describe("the physical joint this dim commands"),
  meaning: z.string().optional(),
  units: z.string().optional().describe('e.g. "m", "rad", "m/s", "normalized"'),
  bounds: z.object({ min: z.number(), max: z.number() }).optional(),
})
export type DeviceAction = z.infer<typeof DeviceAction>

const AccessSection = z.strictObject({ ...section, connection: may(OtherConnection).default(MISSING), driver: DriverSpec.optional() })
const SpatialShape = {
  ...measured,
  method: z.enum(["unknown", "factory", "introspection", "manual", "survey", "joint_range", "tcp_pivot", "bias"]).default("unknown"),
  mount: may(Mount).optional(),
  pose_frame: may(z.string().min(1).nullable()).optional(),
}
// Parent-relative local frames; null components are unknown, never identity.
const localFrames = {
  frames: z.record(
    z.string().min(1).refine((name) => !name.includes(":"), "frame names cannot contain ':'"),
    LocalFrame,
  ).default({}),
}
const SpatialExtrinsics = z.strictObject(SpatialShape).prefault({})

const jointState = {
  ...measured,
  method: z.enum(["unknown", "factory", "introspection", "manual", "joint_range", "survey"]).default("unknown"),
}
const JointIntrinsics = z.strictObject({ ...jointState, ...localFrames, ...jointShape }).superRefine(refineJoint).prefault({})
const HandIntrinsics = z.strictObject({ ...jointState, ...localFrames, ...jointShape, geometry: HandGeometry.optional() })
  .superRefine(refineJoint).superRefine(refineHand).prefault({})
const JointDeviceAccess = z.strictObject({
  ...jointState, connection: may(ControlConnection).default(MISSING),
  driver: driverWith([...actuatedActions, "ik", "fk"]),
})

const forceTorqueState = {
  ...measured,
  method: z.enum(["unknown", "factory", "introspection", "manual", "bias", "survey"]).default("unknown"),
}
const ForceTorqueIntrinsics = z.strictObject({ ...forceTorqueState, ...localFrames, ...forceTorqueShape }).prefault({})
const ForceTorqueAccess = z.strictObject({
  ...forceTorqueState, connection: may(ForceTorqueConnection).default(MISSING),
  driver: driverWith(observationActions),
})

const imuState = {
  ...measured,
  method: z.enum(["unknown", "factory", "introspection", "manual", "bias", "survey"]).default("unknown"),
}
const ImuIntrinsics = z.strictObject({ ...imuState, ...localFrames, ...imuShape }).prefault({})
const ImuAccess = z.strictObject({
  ...imuState, connection: may(SensorConnection).default(MISSING),
  driver: driverWith(observationActions),
})

const endEffectorState = {
  ...measured,
  method: z.enum(["unknown", "factory", "introspection", "manual", "tcp_pivot", "survey"]).default("unknown"),
}
const velocityState = {
  ...measured,
  method: z.enum(["unknown", "factory", "introspection", "manual", "survey"]).default("unknown"),
}
const VelocityIntrinsics = z.strictObject({ ...velocityState, ...localFrames, control: may(VelocityControl).default(MISSING), feedback: may(VelocityFeedback).default(MISSING), stop: may(VelocityStop).default(MISSING) }).prefault({})
const VelocityAccess = z.strictObject({
  ...velocityState, connection: may(ControlConnection).default(MISSING),
  driver: driverWith(actuatedActions),
})
const GripperIntrinsics = z.strictObject({ ...endEffectorState, ...localFrames, ...gripperShape }).prefault({})
const SuctionIntrinsics = z.strictObject({ ...endEffectorState, ...localFrames, ...suctionShape }).prefault({})
const EndEffectorAccess = z.strictObject({
  ...endEffectorState,
  connection: may(ControlConnection).default(MISSING),
  driver: driverWith([...actuatedActions, "introspect"]),
})

// World geometry and clock share a driver, without a parent transform.
const WorldIntrinsics = z.strictObject({
  source: Source.default("unknown"),
  ...worldShape,
  ...localFrames,
}).prefault({})

const cameraState = { source: Source.default("unknown"), ...CameraCalibration }
const CameraAccess = z.strictObject({
  ...cameraState,
  connection: may(CameraConnection).default(MISSING),
  driver: driverWith([...observationActions, "introspect", ...streamActions]),
})
const RgbdExtrinsics = z.strictObject({ ...SpatialShape, depth_to_color: may(Transform).optional() }).prefault({})
const CameraIntrinsicsSection = z.strictObject({
  ...cameraState, ...localFrames,
  color: may(CameraColor).default(MISSING),
}).prefault({})
const RgbdIntrinsicsSection = z.strictObject({
  ...cameraState, ...localFrames,
  color: may(CameraColor).default(MISSING),
  depth: may(CameraDepth).default(MISSING),
}).prefault({})

// A served ML model (perception OR policy — both are inference services; the
// robot-commanding loop lives in controller tools, never in the model device).
const modelState = section
const ModelAccess = z.strictObject({
  ...modelState,
  connection: may(ModelConnection).default(MISSING),
  driver: DriverSpec.optional(),
})
const ModelIntrinsics = z.strictObject({ ...modelState, ...modelShape }).prefault({})
const DetectionIntrinsics = z.strictObject({ ...modelState, ...modelShape, operations: perceptionOperations("detection") }).prefault({})
const SegmentationIntrinsics = z.strictObject({ ...modelState, ...modelShape, operations: perceptionOperations("segmentation") }).prefault({})

// other: no intrinsic model required yet.
const MiscIntrinsics = z
  .strictObject({
    ...section,
    ...localFrames,
  })
  .prefault({})

const deviceBase = {
  name: z.string(),
  // Whether the agent may read from / calibrate this device. /load and /unload
  // flip it; an unloaded device keeps every profile fact but is off-limits to
  // the device tools and stops gating task-ready.
  loaded: z.boolean().default(true),
  access: AccessSection.optional(),
  extrinsics: SpatialExtrinsics,
  meta: z.strictObject({
    created_at: z.string(),
    updated_at: z.string(),
  }),
}

export const Device = z.discriminatedUnion("type", [
  z.strictObject({ ...deviceBase, type: z.literal("velocity"),
    access: VelocityAccess.optional(), intrinsics: VelocityIntrinsics,
  }).superRefine((device, ctx) => {
    for (const key of ["mount", "pose_frame"] as const)
      if (device.extrinsics[key] !== undefined) ctx.addIssue({ code: "custom", path: ["extrinsics", key], message: "velocity devices are unlocalized roots; use explicit frame estimates" })
  }),
  z.strictObject({ ...deviceBase, type: z.literal("dexterous_hand"), access: JointDeviceAccess.optional(), intrinsics: HandIntrinsics }),
  z.strictObject({ ...deviceBase, type: z.literal("suction"), access: EndEffectorAccess.optional(), intrinsics: SuctionIntrinsics }),
  z.strictObject({ ...deviceBase, type: z.literal("joint"),
    access: JointDeviceAccess.optional(), intrinsics: JointIntrinsics,
  }),
  z.strictObject({ ...deviceBase, access: EndEffectorAccess.optional(), type: z.literal("gripper"), intrinsics: GripperIntrinsics }),
  z.strictObject({ ...deviceBase, access: CameraAccess.optional(), type: z.literal("rgb"), intrinsics: CameraIntrinsicsSection }),
  z.strictObject({ ...deviceBase, access: CameraAccess.optional(), extrinsics: RgbdExtrinsics, type: z.literal("rgbd"), intrinsics: RgbdIntrinsicsSection }).superRefine((device, ctx) => {
    const { color, depth } = device.intrinsics
    if (!known(depth)) return
    if (depth.registration === "native" && device.extrinsics.depth_to_color === undefined)
      ctx.addIssue({ code: "custom", path: ["extrinsics", "depth_to_color"], message: "native depth requires depth_to_color (??? until calibrated)" })
    if (depth.registration !== "color") return
    if (device.extrinsics.depth_to_color !== undefined)
      ctx.addIssue({ code: "custom", path: ["extrinsics", "depth_to_color"], message: "color-registered depth inherits the color optical frame" })
    if (!known(color)) return
    for (const key of ["width", "height"] as const)
      if (known(color[key]) && known(depth[key]) && color[key] !== depth[key])
        ctx.addIssue({ code: "custom", path: ["intrinsics", "depth", key], message: "color-registered depth must match the color grid" })
  }),
  z.strictObject({ ...deviceBase, type: z.literal("imu"),
    access: ImuAccess.optional(), intrinsics: ImuIntrinsics,
  }),
  z.strictObject({ ...deviceBase, type: z.literal("force_torque"),
    access: ForceTorqueAccess.optional(), intrinsics: ForceTorqueIntrinsics,
  }),
  // A model has no physical pose: like world, extrinsics is not materialized.
  z.strictObject({ ...deviceBase, type: z.literal("model"), access: ModelAccess.optional(), extrinsics: z.never().optional(), intrinsics: ModelIntrinsics }),
  z.strictObject({ ...deviceBase, type: z.literal("detection"), access: ModelAccess.optional(), extrinsics: z.never().optional(), intrinsics: DetectionIntrinsics }),
  z.strictObject({ ...deviceBase, type: z.literal("segmentation"), access: ModelAccess.optional(), extrinsics: z.never().optional(), intrinsics: SegmentationIntrinsics }),
  z.strictObject({ ...deviceBase, type: z.literal("world"),
    access: z.strictObject({ ...jointState, connection: may(OtherConnection).default(MISSING),
      driver: driverWith(["read", "wait", "load", "unload", "status"]),
    }).optional(), extrinsics: z.never().optional(), intrinsics: WorldIntrinsics,
  }),
  z.strictObject({ ...deviceBase, type: z.literal("other"), intrinsics: MiscIntrinsics }),
]).superRefine((device, ctx) => {
  if ("stop" in device.intrinsics) {
    const stop = device.intrinsics.stop
    if (known(stop) && !stop.affected_devices.includes(device.name)) ctx.addIssue({ code: "custom", path: ["intrinsics", "stop"], message: "stop scope must include this device" })
  }
  if ("frames" in device.intrinsics) {
    const explicit = device.intrinsics.frames
    const computed = modelFrames(device)
    if (new Set(computed).size !== computed.length || computed.some(name => Object.hasOwn(explicit, name)))
      ctx.addIssue({ code: "custom", path: ["intrinsics", "frames"], message: "model-defined frames must be unique; remove duplicate frames entries" })
    const frames = deviceFrames(device)
    if (Object.hasOwn(frames, device.name))
      ctx.addIssue({ code: "custom", path: ["intrinsics", "frames"], message: "named frames must differ from canonical device frame" })
    for (const name of Object.keys(frames)) {
      if (name.includes(":")) ctx.addIssue({ code: "custom", path: ["intrinsics", "frames"], message: "frame names cannot contain ':'" })
      const seen = new Set<string>()
      let current: string | null = name
      while (current !== null) {
        if (seen.has(current) || !Object.hasOwn(frames, current)) {
          ctx.addIssue({ code: "custom", path: ["intrinsics", "frames", name], message: "frame parents must exist and be acyclic" })
          break
        }
        seen.add(current)
        current = frames[current]!.parent_frame
      }
    }
  }
  const spatial = device.extrinsics
  if (!spatial) return
  if (spatial.mount !== undefined && spatial.pose_frame !== undefined)
    ctx.addIssue({ code: "custom", path: ["extrinsics"], message: "choose mounted or measured root placement" })
})
export type Device = z.infer<typeof Device>

// [sim] — descriptive metadata for a simulated embodiment: which simulator the
// profiles in this workspace describe. A simulator workspace SHIPS its device
// profiles (a sim reads out its own intrinsics and extrinsics, so there is
// nothing to interview and nothing to introspect at runtime), and each device
// is reached through its own driver like any other — there is no harness-level
// simulator connection.
const SimConnection = z.object({
  ...section,
  simulator: z.string().describe('simulator kind: "libero" | "robotwin" | "robocasa" | ...'),
  notes: z.string().optional().describe("task/scene/config facts worth carrying into every session"),
})

// The slim robot manifest: whole-assembly facts only. Devices are NOT listed
// here — the devices/ directory is the single source of truth; the `devices`
// section merely carries provenance for the inventory-complete assertion.
export const RobotManifest = z.strictObject({
  // [identity]
  identity: z.object({
    ...section,
    id: z.string(),
    name: z.string(),
    platform: z.enum(["real", "sim"]),
    kind: z.enum(["arm", "mobile", "quadruped", "humanoid", "other"]),
    model: may(z.string()).default(MISSING).describe("make/model, e.g. UR5e, Panda"),
  }),
  // Simulated embodiments only: which simulator these profiles describe.
  sim: SimConnection.optional(),
  // [devices-declared] — inventory marker only; devices/*/profile.yaml are ground truth.
  devices: z.object({ ...section }).prefault({}),
  // [safety]
  safety: z
    .object({
      ...section,
      max_cartesian_velocity: may(z.number().nullable()).default(MISSING).describe("m/s; null = no additional cap; ??? = unspecified"),
      max_joint_velocity: may(z.number().nullable()).default(MISSING).describe("rad/s; null = no additional cap; ??? = unspecified"),
      keep_out_zones: z.array(Aabb).default([]),
      notes: z.string().optional(),
    })
    .prefault({}),
  meta: z.object({
    created_at: z.string(),
    updated_at: z.string(),
  }),
})
export type RobotManifest = z.infer<typeof RobotManifest>

// One compact line for possibly-open workspace bounds — shared by the DAG
// detail and the system-prompt summary: "x∈[-0.6,0.6] y∈[-0.6,0.6] z≥0.02 (open above)".
export function renderWorkspaceBounds(bounds: WorkspaceBounds): string {
  const axes = ["x", "y", "z"] as const
  return axes
    .map((axis, index) => {
      const min = bounds.min[index]
      const max = bounds.max[index]
      if (min !== null && max !== null) return `${axis}∈[${min},${max}]`
      if (min !== null) return `${axis}≥${min} (open above)`
      if (max !== null) return `${axis}≤${max} (open below)`
      return `${axis} open`
    })
    .join(" ")
}

// rgbd IS a camera: a tool's `devices: [rgb]` requirement is satisfied by
// either camera type.
export function isCameraType(type: DeviceType): boolean {
  return type === "rgb" || type === "rgbd"
}

export function isModel(device: Device): device is Extract<Device, { type: "model" | "detection" | "segmentation" }> {
  return device.type === "model" || device.type === "detection" || device.type === "segmentation"
}

export function matchesDeviceType(actual: DeviceType, required: DeviceType): boolean {
  return actual === required || (required === "rgb" && isCameraType(actual))
    || (required === "detection" && actual === "segmentation")
}

// Control contracts determine actuation.
export function isActuated(device: Device): boolean {
  return ["joint", "velocity", "gripper", "dexterous_hand", "suction"].includes(device.type)
}
export function isVelocity(device: Device): device is Extract<Device, { type: "velocity" }> { return device.type === "velocity" }
export function isJoint(device: Device): device is Extract<Device, { type: "joint" | "dexterous_hand" }> { return device.type === "joint" || device.type === "dexterous_hand" }
export function deviceJoints(device: Device) { return isJoint(device) ? jointModel(device.intrinsics)?.joints ?? [] : [] }

// The device's own ordered action space, for the actuated types.
export function deviceActions(device: Device): DeviceAction[] {
  if (isVelocity(device)) {
    const { control } = device.intrinsics
    if (!known(control)) return []
    return Object.entries(control.modes).flatMap(([mode, capabilities]) => [
      ...(capabilities.velocity?.components ?? []).map((c) => ({ component: `${mode}.velocity.${c.axis}`, units: c.units, ...(known(c.bounds) && c.bounds !== null ? { bounds: c.bounds } : {}) })),
      ...(capabilities.posture?.components ?? []).map((c) => ({ component: `${mode}.posture.${c.axis}`, units: c.units, ...(c.bounds !== null ? { bounds: c.bounds } : {}) })),
    ])
  }
  if (isJoint(device)) return deviceJoints(device).map((j) => ({
    joint: j.name, units: j.type === "prismatic" ? "m" : "rad",
    ...(j.limits ? { bounds: j.limits } : {}),
  }))
  if (device.type === "gripper" || device.type === "suction") {
    const control = device.intrinsics.control
    if (!known(control)) return []
    if (control.mode === "binary") return [{ component: "vacuum", units: "normalized", bounds: { min: Math.min(control.off_target, control.on_target), max: Math.max(control.off_target, control.on_target) } }]
    if (control.mode === "direction") return [{ component: "direction", units: "normalized", bounds: { min: -1, max: 1 } }]
    return [{ component: "position", units: control.units, bounds: control.bounds }]
  }
  return []
}

// A device's home configuration, aligned with deviceJoints(); undefined while
// unknown or explicitly unavailable.
export function deviceHome(device: Device): number[] | undefined {
  const joints = deviceJoints(device)
  if (joints.length === 0) return []
  if (isJoint(device)) {
    const home = device.intrinsics.home
    if (!known(home) || home === null) return undefined
    return joints.map((j) => home[j.name]!)
  }
  return undefined
}

// Measured roots declare an external pose reference.
export function devicePoseFeedback(device: Device) {
  if (device.type === "velocity") return undefined
  if (device.extrinsics?.pose_frame !== undefined) return { pose_frame: device.extrinsics.pose_frame }
  return undefined
}

// Runtime placement is a frame reference; fixed placement is the profile mount.
export function deviceMount(device: Device) {
  const feedback = devicePoseFeedback(device)
  if (feedback !== undefined) {
    if (!known(feedback) || !known(feedback.pose_frame) || feedback.pose_frame === null) return undefined
    const [parent, frame] = feedback.pose_frame.split(":")
    return { parent: parent!, parent_frame: frame ?? parent!, translation_m: MISSING, rotation_xyzw: MISSING, dynamic: true }
  }
  const mount = device.extrinsics?.mount
  if (mount === undefined || !known(mount)) return mount
  return { ...mount, dynamic: false }
}

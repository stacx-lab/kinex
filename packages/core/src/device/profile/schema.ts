import { LocalFrame, ControlConnection } from "./common.ts"
import { modelShape } from "./model.ts"
import { imuShape } from "./imu.ts"
import { SensorConnection } from "./sensor.ts"
import { z } from "zod"
import { Operation, RosRuntime } from "./operations.ts"
import { ForceTorqueConnection, forceTorqueShape } from "./force-torque.ts"
import { worldShape, type WorkspaceBounds } from "./world.ts"
export { WorkspaceBounds, Surface } from "./world.ts"
import { VelocityControl, VelocityFeedback, VelocityStop } from "./velocity.ts"
import { LeggedControl, LeggedStop } from "./legged.ts"
import { gripperShape, suctionShape } from "./gripper.ts"
import { jointShape, refineJoint, jointModel } from "./joint.ts"
import { HandGeometry, refineHand } from "./hand.ts"
import { modelFrames, frameErrors } from "./frames.ts"
import { CameraColor, CameraConnection, CameraDepth } from "./camera.ts"

import { MISSING, may, known, section, measured, OtherConnection } from "./common.ts"
export { MISSING, known, Source } from "./common.ts"

// Device profiles own access, intrinsic facts and parent-relative SI mounts.
// Explicit calibration requests persist until cleared by a validated write.

const Aabb = z.object({
  min: z.tuple([z.number(), z.number(), z.number()]),
  max: z.tuple([z.number(), z.number(), z.number()]),
})

export const DeviceType = z.enum([
  "legged_base",
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

// Physical facts and calibration provenance live directly on the profile.
const provenance = {
  ...measured,
  method: z.enum(["unknown", "factory", "introspection", "manual", "survey", "joint_range", "tcp_pivot", "bias", "checkerboard", "charuco", "hand_eye", "plane_fit"]).default("unknown"),
}
const localFrames = {
  frames: z.record(z.string().regex(/^[^:/]+$/, "local frame names cannot contain ':' or '/'"), LocalFrame),
}
const AccessSection = z.strictObject({ ...section, connection: may(OtherConnection).default(MISSING) })
const JointDeviceAccess = z.strictObject({ ...provenance, connection: may(ControlConnection).default(MISSING) })
const deviceBase = {
  name: z.string().regex(/^[^:/]+$/),
  description: z.string().describe("General device identity, capabilities and limitations; may be empty"),
  ...provenance,
  runtime: RosRuntime.optional(),
  operations: z.record(z.string().regex(/^[a-zA-Z_]\w*$/), Operation).default({}),
  loaded: z.boolean().default(true),
  access: AccessSection.optional(),
  meta: z.strictObject({ created_at: z.string(), updated_at: z.string() }),
}
const spatial = { ...deviceBase, ...localFrames }
const camera = { ...spatial, access: z.strictObject({ ...provenance, connection: may(CameraConnection).default(MISSING) }).optional(), color: may(CameraColor).default(MISSING) }

export const Device = z.discriminatedUnion("type", [
  z.strictObject({ ...spatial, type: z.literal("legged_base"), control: may(LeggedControl).default(MISSING), stop: may(LeggedStop).default(MISSING) }),
  z.strictObject({ ...spatial, type: z.literal("velocity"), access: JointDeviceAccess.optional(), control: may(VelocityControl).default(MISSING), feedback: may(VelocityFeedback).default(MISSING), stop: may(VelocityStop).default(MISSING) }),
  z.strictObject({ ...spatial, ...jointShape, type: z.literal("joint"), access: JointDeviceAccess.optional() }).superRefine(refineJoint),
  z.strictObject({ ...spatial, ...jointShape, type: z.literal("dexterous_hand"), access: JointDeviceAccess.optional(), geometry: HandGeometry.optional() }).superRefine(refineJoint).superRefine(refineHand),
  z.strictObject({ ...spatial, ...gripperShape, type: z.literal("gripper"), access: JointDeviceAccess.optional() }),
  z.strictObject({ ...spatial, ...suctionShape, type: z.literal("suction"), access: JointDeviceAccess.optional() }),
  z.strictObject({ ...camera, type: z.literal("rgb") }),
  z.strictObject({ ...camera, type: z.literal("rgbd"), depth: may(CameraDepth).default(MISSING) }).superRefine((device, ctx) => {
    const { color, depth } = device
    if (!known(depth)) return
    if (depth.registration === "native" && (!device.frames.color || !device.frames.depth))
      ctx.addIssue({ code: "custom", path: ["frames"], message: "native depth requires color and depth frames" })
    if (depth.registration !== "color" || !known(color)) return
    for (const key of ["width", "height"] as const)
      if (known(color[key]) && known(depth[key]) && color[key] !== depth[key])
        ctx.addIssue({ code: "custom", path: ["depth", key], message: "color-registered depth must match the color grid" })
  }),
  z.strictObject({ ...spatial, ...imuShape, type: z.literal("imu"), access: z.strictObject({ ...provenance, connection: may(SensorConnection).default(MISSING) }).optional() }),
  z.strictObject({ ...spatial, ...forceTorqueShape, type: z.literal("force_torque"), access: z.strictObject({ ...provenance, connection: may(ForceTorqueConnection).default(MISSING) }).optional() }),
  z.strictObject({ ...deviceBase, ...modelShape, type: z.literal("model") }),
  z.strictObject({ ...spatial, ...worldShape, type: z.literal("world") }),
  z.strictObject({ ...spatial, type: z.literal("other") }),
]).superRefine((device, ctx) => {
  for (const name of ["load", "unload", "status"])
    if (Object.hasOwn(device.operations, name))
      ctx.addIssue({ code: "custom", path: ["operations", name], message: "reserved host lifecycle operation" })
  if (device.operations.stop && device.operations.stop.transport !== "service")
    ctx.addIssue({ code: "custom", path: ["operations", "stop"], message: "stop must be a service" })
  if (device.runtime && Object.values(device.operations).some(op => op.motion) && device.operations.stop?.type !== "kinex_interfaces/srv/Stop")
    ctx.addIssue({ code: "custom", path: ["operations"], message: "managed motion requires a stop service" })
  if ("stop" in device && known(device.stop) && !device.stop.affected_devices.includes(device.name))
    ctx.addIssue({ code: "custom", path: ["stop"], message: "stop scope must include this device" })
  if (!("frames" in device)) return
  if (!device.frames.base) ctx.addIssue({ code: "custom", path: ["frames", "base"], message: "spatial devices require an explicit base frame" })
  const computed = modelFrames(device)
  if (new Set(computed).size !== computed.length)
    ctx.addIssue({ code: "custom", path: ["frames"], message: "model-defined frames must be unique" })
  for (const name of computed) {
    const frame = device.frames[name]
    if (!frame || frame.parent !== `${device.name}:base` || frame.translation_m !== null || frame.rotation_xyzw !== null)
      ctx.addIssue({ code: "custom", path: ["frames", name], message: "model frame must declare device:base parent and null static transform components" })
  }
  for (const message of frameErrors([device], false))
    ctx.addIssue({ code: "custom", path: ["frames"], message })
})
export type Device = z.infer<typeof Device>

// The slim robot manifest: whole-assembly facts only. Devices are NOT listed
// here — the devices/ directory is the single source of truth; the `devices`
// section merely carries provenance for the inventory-complete assertion.
export const RobotManifest = z.strictObject({
  // [identity]
  identity: z.object({
    ...section,
    id: z.string(),
    name: z.string(),
    kind: z.enum(["arm", "mobile", "quadruped", "humanoid", "other"]),
    model: may(z.string()).default(MISSING).describe("make/model, e.g. UR5e, Panda"),
  }),
  // [devices-declared] — inventory marker only; devices/*/profile.yaml are ground truth.
  devices: z.object({ ...section }).prefault({}),
  // [safety]
  safety: z
    .object({
      ...section,
      max_cartesian_velocity: may(z.number().nullable()).default(MISSING).describe("m/s; null = no additional cap; ??? = unspecified"),
      max_joint_velocity: may(z.number().nullable()).default(MISSING).describe("rad/s; null = no additional cap; ??? = unspecified"),
      keep_out_zones: z.array(Aabb).default([]),
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

export function matchesDeviceType(actual: DeviceType, required: DeviceType): boolean {
  return actual === required || (required === "rgb" && isCameraType(actual))
}

// Control contracts determine actuation.
export function isActuated(device: Device): boolean {
  return ["joint", "velocity", "legged_base", "gripper", "dexterous_hand", "suction"].includes(device.type)
}
export function isVelocity(device: Device): device is Extract<Device, { type: "velocity" }> { return device.type === "velocity" }
export function isJoint(device: Device): device is Extract<Device, { type: "joint" | "dexterous_hand" }> { return device.type === "joint" || device.type === "dexterous_hand" }
export function deviceJoints(device: Device) { return isJoint(device) ? jointModel(device)?.joints ?? [] : [] }

// The device's own ordered action space, for the actuated types.
export function deviceActions(device: Device): DeviceAction[] {
  if (isVelocity(device)) {
    const { control } = device
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
    const control = device.control
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
    const home = device.home
    if (!known(home) || home === null) return undefined
    return joints.map((j) => home[j.name]!)
  }
  return undefined
}

// A mount is simply the device's declared base edge.
export function deviceMount(device: Device) {
  if (!("frames" in device)) return undefined
  const base = device.frames.base
  if (!base || base.parent === null) return undefined
  const [parent, parent_frame] = base.parent.split(":")
  return { ...base, parent: parent!, parent_frame: parent_frame! }
}

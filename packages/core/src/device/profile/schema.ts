import { LocalFrame } from "./common.ts"
import { modelShape } from "./model.ts"
import { imuShape } from "./imu.ts"
import { z } from "zod"
import { Operation, RosRuntime } from "./operations.ts"
import { forceTorqueShape } from "./force-torque.ts"
import { worldShape, type WorkspaceBounds } from "./world.ts"
export { WorkspaceBounds, Surface } from "./world.ts"
import { locomotionShape, refineLocomotion } from "./locomotion.ts"
import { gripperShape } from "./gripper.ts"
import { suctionShape } from "./suction.ts"
import { commandedJoints, deviceTree } from "./urdf.ts"
import { jointShape } from "./joint.ts"
import { deviceFrames, frameErrors } from "./frames.ts"
import { CameraColor, CameraDepth } from "./camera.ts"

import { MISSING, may, known, section, measured } from "./common.ts"
export { MISSING, known, Source } from "./common.ts"

// Device profiles own access, intrinsic facts and parent-relative SI mounts.
// Explicit calibration requests persist until cleared by a validated write.

const Aabb = z.object({
  min: z.tuple([z.number(), z.number(), z.number()]),
  max: z.tuple([z.number(), z.number(), z.number()]),
})

export const DeviceType = z.enum([
  "locomotion",
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

// One device-local command dimension. Joint targets use model order; locomotion
// velocity and posture axes are listed for capability display, not one command vector.
export const DeviceAction = z.object({
  component: z.string().optional().describe('non-joint dim: "vacuum", "velocity.vx", "posture.height", ...'),
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
// How a device is reached belongs to its runtime nodes; access only carries an
// explicit request against the access:<device> readiness item.
const Access = z.strictObject({ needs_calibration: section.needs_calibration })
const deviceBase = {
  name: z.string().regex(/^[^:/]+$/),
  description: z.string().describe("General device identity, capabilities and limitations; may be empty"),
  ...provenance,
  runtime: RosRuntime.optional(),
  operations: z.record(z.string().regex(/^[a-zA-Z_]\w*$/), Operation).default({}),
  loaded: z.boolean().default(true),
  access: Access.optional(),
  meta: z.strictObject({ created_at: z.string(), updated_at: z.string() }),
}
const spatial = { ...deviceBase, ...localFrames }
const camera = { ...spatial, color: may(CameraColor).default(MISSING) }

export const Device = z.discriminatedUnion("type", [
  z.strictObject({ ...spatial, ...locomotionShape, type: z.literal("locomotion") }).superRefine(refineLocomotion),
  z.strictObject({ ...spatial, ...jointShape, type: z.literal("joint") }),
  z.strictObject({ ...spatial, ...gripperShape, type: z.literal("gripper") }),
  z.strictObject({ ...spatial, ...suctionShape, type: z.literal("suction") }),
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
  z.strictObject({ ...spatial, ...imuShape, type: z.literal("imu") }),
  z.strictObject({ ...spatial, ...forceTorqueShape, type: z.literal("force_torque") }),
  z.strictObject({ ...deviceBase, ...modelShape, type: z.literal("model") }),
  z.strictObject({ ...spatial, ...worldShape, type: z.literal("world") }),
  // The fallback type prescribes nothing and may have no spatial frames.
  z.strictObject({ ...deviceBase, frames: localFrames.frames.optional(), type: z.literal("other") }),
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
  if (!("frames" in device) || !device.frames) return
  if (!device.frames.base) ctx.addIssue({ code: "custom", path: ["frames", "base"], message: "spatial devices require an explicit base frame" })
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
  return ["joint", "locomotion", "gripper", "suction"].includes(device.type)
}
export function isJoint(device: Device): device is Extract<Device, { type: "joint" }> { return device.type === "joint" }
export function deviceJoints(device: Device) { return isJoint(device) ? commandedJoints(deviceTree(device)) : [] }

// The device's own ordered action space, for the actuated types.
export function deviceActions(device: Device): DeviceAction[] {
  if (device.type === "locomotion") {
    const velocity = known(device.velocity) ? device.velocity : null
    const posture = known(device.posture) ? device.posture : null
    const action = (component: string, units: string, bounds?: { min: number, max: number } | null) =>
      ({ component, units, ...(bounds ? { bounds } : {}) })
    const speed = (axis: string) => velocity?.units === "normalized" ? "normalized" : axis.startsWith("v") ? "m/s" : "rad/s"
    return [
      ...Object.entries(velocity?.axes ?? {}).map(([axis, bounds]) => action(`velocity.${axis}`, speed(axis), bounds)),
      ...Object.entries(posture ?? {}).map(([axis, bounds]) => action(`posture.${axis}`, axis === "height" ? "m" : "rad", bounds)),
    ]
  }
  if (isJoint(device)) return deviceJoints(device).map((j) => ({
    joint: j.name, units: j.type === "prismatic" ? "m" : "rad",
    ...(j.limits ? { bounds: j.limits } : {}),
  }))
  if (device.type === "gripper") {
    const grip = device.grip
    if (!known(grip)) return []
    const joint = deviceTree(device)?.joints.find((item) => item.name === grip.joint)
    return [{ joint: grip.joint, units: joint?.type === "prismatic" ? "m" : "rad",
      bounds: { min: Math.min(grip.open, grip.closed), max: Math.max(grip.open, grip.closed) } }]
  }
  if (device.type === "suction")
    return known(device.vacuum) ? [{ component: "vacuum", units: "normalized", bounds: { min: 0, max: 1 } }] : []
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
  const base = deviceFrames(device).base
  if (!base || base.parent === null) return undefined
  const [parent, parent_frame] = base.parent.split(":")
  return { ...base, parent: parent!, parent_frame: parent_frame! }
}

import { field } from "./common.ts"
import { z } from "zod"
import type { UrdfTree } from "./urdf.ts"

const name = z.string().min(1)
const units = z.enum(["m", "rad", "controller_count", "normalized"])

const SuctionFeedback = z.strictObject({
  positions: z.array(z.strictObject({ name: z.string().min(1), units })),
  velocities: z.boolean(),
  sensors: z.array(z.enum(["force_n", "object_detected", "pressure_pa"])).default([])
    .refine((v) => new Set(v).size === v.length, "duplicate sensor"),
  aperture_model: z.strictObject({ model: z.literal("affine"), coefficients: z.array(z.number()).min(1), offset_m: z.number() }).nullable().default(null),
}).superRefine((feedback, ctx) => {
  if (new Set(feedback.positions.map((p) => p.name)).size !== feedback.positions.length)
    ctx.addIssue({ code: "custom", path: ["positions"], message: "position channel names must be unique" })
  if (feedback.aperture_model !== null && feedback.aperture_model.coefficients.length !== feedback.positions.length)
    ctx.addIssue({ code: "custom", path: ["aperture_model"], message: "one coefficient is required per measured position" })
})

export const EndEffectorStop = z.strictObject({
  behavior: z.enum(["hold", "halt", "controller_emergency_stop"]),
  affected_devices: z.array(z.string().min(1)),
}).refine((v) => new Set(v.affected_devices).size === v.affected_devices.length, "affected_devices must be unique")

// Geometry lives in the URDF: every link below base_link is a TF frame of the device.
export const GripperModel = z.strictObject({ format: z.literal("urdf"), path: field(name), base_link: field(name) })
// The actuated URDF joint and its positions at full open and full close.
export const Grip = z.strictObject({ joint: name, open: z.number(), closed: z.number() })
  .refine((v) => v.open !== v.closed, "open and closed must differ")

// The grip drives an independent URDF joint within its limits; URDF links share
// the device namespace with profile frames, so their names must not collide.
export function gripErrors(device: { grip: z.infer<typeof Grip> | "???"; frames: Record<string, unknown> }, tree: UrdfTree) {
  const errors = tree.links.filter((link) => link !== tree.base_link && Object.hasOwn(device.frames, link))
    .map((link) => `URDF link ${link} collides with profile frame ${link}`)
  if (device.grip === "???") return errors
  const { joint: name, open, closed } = device.grip
  const joint = tree.joints.find((item) => item.name === name)
  if (!joint || joint.type === "fixed" || joint.mimic) return [...errors, `grip joint ${name} must be an independent movable URDF joint`]
  const limits = joint.limits
  if (limits && [open, closed].some((value) => value < limits.min || value > limits.max))
    errors.push(`grip open/closed must lie within ${name} limits [${limits.min}, ${limits.max}]`)
  return errors
}

export const gripperShape = {
  model: field(GripperModel),
  grip: field(Grip),
  stop: field(EndEffectorStop),
}
export const suctionShape = {
  control: field(z.strictObject({ mode: z.literal("binary"), off_target: z.number(), on_target: z.number() }).refine((v) => v.off_target !== v.on_target, "on/off targets must differ")),
  feedback: field(SuctionFeedback), stop: field(EndEffectorStop),
}

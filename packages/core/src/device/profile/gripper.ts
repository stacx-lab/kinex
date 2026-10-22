import { ActuatorStop, field, known } from "./common.ts"
import { z } from "zod"
import { UrdfModel, commandedJoints, type UrdfTree } from "./urdf.ts"

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

// The actuated URDF joint and its positions at full open and full close.
export const Grip = z.strictObject({ joint: name, open: z.number(), closed: z.number() })
  .refine((v) => v.open !== v.closed, "open and closed must differ")

// The grip drives an independent URDF joint within its limits.
export function gripErrors(device: { grip: z.infer<typeof Grip> | "???" }, tree: UrdfTree): string[] {
  if (!known(device.grip)) return []
  const { joint: name, open, closed } = device.grip
  const joint = commandedJoints(tree).find((item) => item.name === name)
  if (!joint) return [`grip joint ${name} must be an independent movable URDF joint`]
  const limits = joint.limits
  return limits && [open, closed].some((value) => value < limits.min || value > limits.max)
    ? [`grip open/closed must lie within ${name} limits [${limits.min}, ${limits.max}]`] : []
}

export const gripperShape = {
  model: field(UrdfModel),
  grip: field(Grip),
  stop: field(ActuatorStop),
}
export const suctionShape = {
  control: field(z.strictObject({ mode: z.literal("binary"), off_target: z.number(), on_target: z.number() }).refine((v) => v.off_target !== v.on_target, "on/off targets must differ")),
  feedback: field(SuctionFeedback), stop: field(ActuatorStop),
}

import { field } from "./common.ts"
import { z } from "zod"

const axis = z.enum(["vx", "vy", "vz", "wx", "wy", "wz"])
const bounds = z.strictObject({ min: z.number(), max: z.number() }).refine(
  (v) => v.min < v.max && v.min <= 0 && v.max >= 0, "velocity bounds must include zero",
)
const component = z.strictObject({
  axis, units: z.enum(["m/s", "rad/s", "normalized"]), bounds: field(bounds.nullable()),
}).refine((v) => v.units === "normalized" || v.units === (v.axis.startsWith("v") ? "m/s" : "rad/s"), "units must match velocity axis")
const unique = (values: readonly string[]) => new Set(values).size === values.length

const motionMode = z.strictObject({
  velocity: z.strictObject({
    frame: z.enum(["body", "heading"]),
    components: z.array(component).min(1).refine((v) => unique(v.map((c) => c.axis)), "duplicate velocity axis"),
  }).nullable(),
  posture: z.strictObject({
    reference: z.string().min(1),
    components: z.array(z.strictObject({
      axis: z.enum(["height", "roll", "pitch", "yaw"]),
      units: z.enum(["m", "rad"]),
      bounds: z.strictObject({ min: z.number(), max: z.number() }).nullable(),
      default: z.number(),
    }).superRefine((v, ctx) => {
      if (v.units !== (v.axis === "height" ? "m" : "rad"))
        ctx.addIssue({ code: "custom", message: "posture units must match axis" })
      if (v.bounds && (v.bounds.min >= v.bounds.max || v.default < v.bounds.min || v.default > v.bounds.max || (v.axis === "height" && v.bounds.min <= 0)))
        ctx.addIssue({ code: "custom", message: "invalid posture bounds or default" })
    })).min(1).refine((v) => unique(v.map((c) => c.axis)), "duplicate posture axis"),
  }).nullable(),
}).refine((v) => v.velocity !== null || v.posture !== null, "a motion mode needs velocity or posture")


export const VelocityControl = z.strictObject({
  mode: z.literal("motion"),
  limit_handling: z.literal("native").optional(),
  body_frame: z.string().min(1),
  modes: z.record(z.string().min(1), motionMode).refine((v) => Object.keys(v).length > 0, "at least one controller mode is required"),
})
export const VelocityStop = z.strictObject({
  behavior: z.enum(["stand", "hold", "halt", "controller_emergency_stop"]),
  affected_devices: z.array(z.string().min(1)).min(1).refine(unique, "duplicate stop member"),
})
export const VelocityFeedback = z.strictObject({
  velocity_frame: field(z.string().min(1).nullable()),
  velocity_components: field(z.array(axis).refine(unique, "duplicate measured axis")),
}).superRefine((v, ctx) => {
  if (v.velocity_components === "???" || v.velocity_frame === "???") return
  if ((v.velocity_components.length === 0) !== (v.velocity_frame === null))
    ctx.addIssue({ code: "custom", message: "velocity frame is null exactly when measured components are empty" })
})

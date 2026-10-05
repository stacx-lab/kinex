import { field, xyz } from "./common.ts"
import { z } from "zod"

const positive = z.number().positive()
const axis = xyz.refine((v) => Math.abs(Math.hypot(...v) - 1) < 1e-6, "unit axis required")

export const GripperGeometry = z.strictObject({
  description: z.string().min(1).optional(),
  approach_axis: field(axis.nullable()),
  closing_axis: field(axis.nullable()),
})
const bounds = z.strictObject({ min: z.number(), max: z.number() }).refine((v) => v.min < v.max, "min must be below max")
const physicalRange = z.strictObject({ min: z.number().nonnegative(), max: positive }).refine((v) => v.min < v.max, "min must be below max")
const units = z.enum(["m", "rad", "controller_count", "normalized"])
const speed = z.strictObject({
  native_bounds: bounds, native_resolution: positive.nullable(),
  native_units: z.enum(["controller_unit", "m/s", "rad/s"]), default_fraction: positive.max(1),
}).nullable()

export const EndEffectorControl = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("position"), units, bounds, resolution: positive.nullable(), open_target: z.number(), close_target: z.number(), speed: field(speed) }),
  z.strictObject({ mode: z.literal("direction"), open_target: z.number(), close_target: z.number() }),
]).superRefine((control, ctx) => {
  if (control.open_target === control.close_target) ctx.addIssue({ code: "custom", message: "open/close targets must differ" })
  if (control.mode === "direction") {
    if (control.open_target * control.close_target !== -1 || Math.abs(control.open_target) !== 1 || Math.abs(control.close_target) !== 1)
      ctx.addIssue({ code: "custom", message: "direction endpoints must be opposite -1/+1" })
    return
  }
  for (const key of ["open_target", "close_target"] as const) {
    const value = control[key]
    if (value < control.bounds.min || value > control.bounds.max) ctx.addIssue({ code: "custom", path: [key], message: "target exceeds command bounds" })
    if (control.resolution !== null && Math.abs(value / control.resolution - Math.round(value / control.resolution)) > 1e-8)
      ctx.addIssue({ code: "custom", path: [key], message: "target must lie on the command resolution grid" })
  }
  if (control.speed !== "???" && control.speed !== null && control.speed.native_bounds.min < 0)
    ctx.addIssue({ code: "custom", path: ["speed", "native_bounds"], message: "speed bounds must be nonnegative" })
})

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

const GripperFeedback = z.strictObject({ aperture_m: z.boolean() })

export const EndEffectorStop = z.strictObject({
  behavior: z.enum(["hold", "halt", "controller_emergency_stop"]),
  affected_devices: z.array(z.string().min(1)),
}).refine((v) => new Set(v.affected_devices).size === v.affected_devices.length, "affected_devices must be unique")


export const gripperShape = {
  geometry: GripperGeometry.optional(),
  aperture_m: physicalRange.nullable().default(null),
  control: field(EndEffectorControl), feedback: field(GripperFeedback), stop: field(EndEffectorStop),
}
export const suctionShape = {
  control: field(z.strictObject({ mode: z.literal("binary"), off_target: z.number(), on_target: z.number() }).refine((v) => v.off_target !== v.on_target, "on/off targets must differ")),
  feedback: field(SuctionFeedback), stop: field(EndEffectorStop),
}

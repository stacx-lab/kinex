import { z } from "zod"

export const MISSING = "???" as const
export const may = <T extends z.ZodType>(schema: T) => z.union([schema, z.literal(MISSING)])
export const field = <T extends z.ZodType>(schema: T) => may(schema).default(MISSING)
export const known = <T>(value: T | typeof MISSING): value is T => value !== MISSING
export const Source = z.enum(["user", "calibration", "introspected", "default", "unknown"])
export type Source = z.infer<typeof Source>
export const section = { source: Source.default("unknown"), needs_calibration: z.string().min(1).nullable().optional() }
export const measured = { ...section, calibrated_at: z.iso.datetime().nullable().default(null) }

export const xyz = z.tuple([z.number(), z.number(), z.number()])
export const quaternion = z.tuple([z.number(), z.number(), z.number(), z.number()])
  .refine((q) => Math.abs(Math.hypot(...q) - 1) < 1e-6, "unit quaternion xyzw required")
export const Pose = z.tuple([z.number(), z.number(), z.number(), z.number(), z.number(), z.number(), z.number()])
  .refine((v) => Math.abs(Math.hypot(...v.slice(3)) - 1) < 1e-6, "unit quaternion required")
export const Transform = z.strictObject({ translation_m: field(xyz), rotation_xyzw: field(quaternion) })
export const LocalFrame = z.strictObject({
  parent: z.string().regex(/^[^:/]+:[^:/]+$/, "expected device:frame").nullable(),
  translation_m: xyz.nullable(),
  rotation_xyzw: quaternion.nullable(),
})
export type LocalFrame = z.infer<typeof LocalFrame>

export const ActuatorStop = z.strictObject({
  behavior: z.enum(["hold", "halt", "controller_emergency_stop"]),
  affected_devices: z.array(z.string().min(1)).min(1).refine((v) => new Set(v).size === v.length, "affected_devices must be unique"),
})

export function hasMissing(value: unknown): boolean {
  if (value === MISSING) return true
  if (!value || typeof value !== "object") return false
  return Object.values(value).some(hasMissing)
}

/** Host lifecycle actions every device has; they are never declared operations. */
export const lifecycle: readonly string[] = ["load", "unload", "status"]

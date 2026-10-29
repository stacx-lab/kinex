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
export const LocalFrame = z.strictObject({
  parent: z.string().regex(/^[^:/]+:[^:/]+$/, "expected device:frame").nullable(),
  translation_m: field(xyz.nullable()),
  rotation_xyzw: field(quaternion.nullable()),
}).superRefine((frame, ctx) => {
  for (const key of ["translation_m", "rotation_xyzw"] as const) {
    if (frame.parent === null ? frame[key] !== null : frame[key] === null)
      ctx.addIssue({ code: "custom", path: [key], message: frame.parent === null
        ? "root transform components must be null (inapplicable)"
        : "non-root transform components must be numeric tuples or ??? (unknown)" })
  }
})
export type LocalFrame = z.infer<typeof LocalFrame>

export const ActuatorStop = z.strictObject({
  behavior: z.enum(["hold", "halt", "controller_emergency_stop"]),
  affected_devices: z.array(z.string().min(1)).min(1).refine((v) => new Set(v).size === v.length, "affected_devices must be unique"),
})

// Whether any nested fact is still ???, ignoring the optional keys at any depth.
export function hasMissing(value: unknown, optional: readonly string[] = []): boolean {
  if (value === MISSING) return true
  if (!value || typeof value !== "object") return false
  return Object.entries(value).some(([key, entry]) => !optional.includes(key) && hasMissing(entry, optional))
}
export const anyMissing = (...values: unknown[]) => values.some(value => hasMissing(value))

/** Host lifecycle actions every device has; they are never declared operations. */
export const lifecycle: readonly string[] = ["load", "unload", "status"]

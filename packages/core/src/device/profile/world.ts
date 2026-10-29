import { field, quaternion, section, xyz } from "./common.ts"
import { z } from "zod"

const side = z.number().nullable()

// Spatial information in world coordinates, never an implicit motion policy.
export const WorkspaceBounds = z.strictObject({
  min: z.tuple([side, side, side]),
  max: z.tuple([side, side, side]),
}).superRefine((box, ctx) => {
  for (const axis of [0, 1, 2] as const) {
    const low = box.min[axis]
    const high = box.max[axis]
    if (low !== null && high !== null && low > high)
      ctx.addIssue({ code: "custom", path: ["max", axis], message: "maximum must be at least minimum" })
  }
})
export type WorkspaceBounds = z.infer<typeof WorkspaceBounds>

const polygon = z.array(z.tuple([z.number(), z.number()])).min(3).refine((vertices) => {
  const area = vertices.reduce((sum, [x, y], i) => {
    const next = vertices[(i + 1) % vertices.length]!
    return sum + x * next[1] - y * next[0]
  }, 0)
  return Math.abs(area) > 1e-12 && new Set(vertices.map((v) => v.join(","))).size === vertices.length
}, "polygon must have distinct vertices and nonzero area")

export const Surface = z.strictObject({
  name: z.string().min(1),
  pose: field(z.strictObject({ translation_m: xyz, rotation_xyzw: quaternion })),
  extent: field(z.discriminatedUnion("shape", [
    z.strictObject({ shape: z.literal("rectangle"), size_m: z.tuple([z.number().positive(), z.number().positive()]) }),
    z.strictObject({ shape: z.literal("polygon"), vertices_m: polygon }),
    z.strictObject({ shape: z.literal("unbounded") }),
  ])),
})
export type Surface = z.infer<typeof Surface>

export const worldShape = {
  needs_calibration: section.needs_calibration,
  method: z.enum(["unknown", "manual", "survey", "introspection", "plane_fit"]).default("unknown"),
  calibrated_at: z.iso.datetime().nullable().default(null),
  bounds: field(WorkspaceBounds.nullable()),
  surfaces: z.array(Surface).default([]).refine((items) => new Set(items.map((s) => s.name)).size === items.length, "surface names must be unique"),
}

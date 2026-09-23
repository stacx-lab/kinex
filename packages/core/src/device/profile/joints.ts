import { z } from "zod"

const positive = z.number().positive()
const bounds = z.strictObject({ min: z.number(), max: z.number() }).refine((v) => v.min < v.max, "min must be below max")

export const Joint = z.strictObject({
  name: z.string().min(1), type: z.enum(["revolute", "continuous", "prismatic"]),
  limits: bounds.nullable(), max_velocity: positive.nullable(), max_effort: positive.nullable(), max_acceleration: positive.nullable().optional(),
}).superRefine((joint, ctx) => {
  if ((joint.type === "continuous") !== (joint.limits === null))
    ctx.addIssue({ code: "custom", path: ["limits"], message: "only continuous joints have null position limits" })
})

const vector = z.tuple([z.number(), z.number(), z.number()])
const pose = z.tuple([z.number(), z.number(), z.number(), z.number(), z.number(), z.number(), z.number()])
  .refine((v) => Math.abs(Math.hypot(...v.slice(3)) - 1) < 1e-5, "unit quaternion required")

export const Joints = z.array(Joint).min(1).refine((v) => new Set(v.map((j) => j.name)).size === v.length, "joint names must be unique")
export const ChainLink = z.union([
  z.strictObject({ origin: pose }),
  z.strictObject({ origin: pose, joint: z.number().int().nonnegative(),
    axis: vector.refine((v) => Math.abs(Math.hypot(...v) - 1) < 1e-5, "unit axis required"),
    anchor: vector, reference: z.number(),
  }),
])

export function jointConfigurationErrors(value: {
  home: Record<string, number> | null | "???",
}, model: { joints: z.infer<typeof Joints> }): string[] {
  const home = value.home
  if (home === "???" || home === null) return []
  const errors: string[] = []
  const names = model.joints.map(j => j.name)
  if (Object.keys(home).length !== names.length || names.some(name => !Object.hasOwn(home, name)))
    errors.push("home must name every model joint exactly once")
  for (const joint of model.joints) {
    const q = home[joint.name]
    if (q !== undefined && joint.limits && (q < joint.limits.min || q > joint.limits.max))
      errors.push(`home exceeds limits for ${joint.name}`)
  }
  return errors
}

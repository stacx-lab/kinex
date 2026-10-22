import { ActuatorStop, field, known } from "./common.ts"
import { z } from "zod"
import { UrdfModel, commandedJoints, type UrdfTree } from "./urdf.ts"

const name = z.string().min(1)

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

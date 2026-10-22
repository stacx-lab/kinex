import { z } from "zod"

const name = z.string().min(1)
const rate = z.number().positive().nullable()

// A URDF tree below its base link, as kinex.urdf.read_tree resolves it.
export const UrdfJoint = z.discriminatedUnion("type", [
  z.strictObject({ name, type: z.literal("fixed"), parent: name, child: name, origin: z.array(z.number()).length(7) }),
  z.strictObject({
    name, type: z.enum(["revolute", "continuous", "prismatic"]), parent: name, child: name, origin: z.array(z.number()).length(7),
    axis: z.array(z.number()).length(3), limits: z.strictObject({ min: z.number(), max: z.number() }).nullable(),
    max_velocity: rate, max_effort: rate,
    mimic: z.strictObject({ joint: name, multiplier: z.number(), offset: z.number() }).nullable(),
  }),
])
export const UrdfTree = z.strictObject({ base_link: name, links: z.array(name), joints: z.array(UrdfJoint) })
export type UrdfTree = z.infer<typeof UrdfTree>

export const resolvedTrees = new WeakMap<object, UrdfTree>()

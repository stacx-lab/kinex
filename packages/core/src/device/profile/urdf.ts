import { z } from "zod"
import { field, hasMissing, known } from "./common.ts"
import type { Device } from "./schema.ts"

const name = z.string().min(1)
const rate = z.number().positive().nullable()

// Geometry lives in the URDF: every link below base_link is a TF frame of the device.
export const UrdfModel = z.strictObject({ format: z.literal("urdf"), path: field(name), base_link: field(name) })

// A URDF tree below its base link, as kinex.urdf.read_tree resolves it in document order.
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
export const modelErrors = new WeakMap<object, string>()

// The complete URDF reference of a joint or gripper device.
export function urdfSpec(device: Device) {
  if (device.type !== "joint" && device.type !== "gripper") return undefined
  return known(device.model) && !hasMissing(device.model) ? device.model : undefined
}

export function deviceTree(device: Device): UrdfTree | undefined {
  const spec = urdfSpec(device)
  return spec && resolvedTrees.get(spec)
}

// A device commands its independent movable joints in URDF document order.
export function commandedJoints(tree: UrdfTree | undefined) {
  return (tree?.joints ?? []).flatMap(joint => joint.type !== "fixed" && !joint.mimic ? [joint] : [])
}

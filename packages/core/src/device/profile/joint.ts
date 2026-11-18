import { z } from "zod"
import { ActuatorStop, field, known } from "./common.ts"
import { UrdfModel, commandedJoints, type UrdfTree } from "./urdf.ts"

const name = z.string().min(1)
const unique = (values: readonly string[]) => new Set(values).size === values.length

export const jointShape = {
  // tip_links end the device's kinematic chains, such as an arm's flange or a hand's fingertips.
  model: field(UrdfModel.extend({ tip_links: field(z.array(name).refine(unique, "duplicate tip link")) })),
  home: field(z.record(name, z.number()).nullable()),
  // strict rejects targets outside URDF limits; native leaves them to the device.
  limits: z.enum(["strict", "native"]).default("strict"),
  stop: field(ActuatorStop),
}
type JointFacts = z.infer<z.ZodObject<typeof jointShape>>

export function jointErrors(device: Pick<JointFacts, "model" | "home">, tree: UrdfTree): string[] {
  const errors: string[] = []
  const tips = known(device.model) && known(device.model.tip_links) ? device.model.tip_links : []
  // FK/IK and pose targets solve the joints from the base link to each tip.
  const parents = new Map(tree.joints.map(joint => [joint.child, joint]))
  for (const tip of tips) {
    const path: UrdfTree["joints"] = []
    for (let joint = parents.get(tip); joint; joint = parents.get(joint.parent)) path.push(joint)
    if (!commandedJoints({ ...tree, joints: path }).length || path.some(joint => joint.type !== "fixed" && joint.mimic))
      errors.push(`tip_links ${tip} must be a link below ${tree.base_link} reached through independent movable joints`)
    for (const other of tips)
      if (path.some(joint => joint.parent === other)) errors.push(`tip_links ${other} lies on the chain of ${tip}`)
  }
  const home = device.home
  if (!known(home) || home === null) return errors
  const joints = commandedJoints(tree)
  if (Object.keys(home).length !== joints.length || joints.some(joint => !Object.hasOwn(home, joint.name)))
    errors.push("home must name every commanded joint exactly once")
  for (const { name, limits } of joints) {
    const q = home[name]
    if (q !== undefined && limits && (q < limits.min || q > limits.max)) errors.push(`home exceeds limits for ${name}`)
  }
  return errors
}

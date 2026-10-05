import { z } from "zod"
import { Pose, quaternion, xyz } from "./common.ts"
import { jointModel, type JointIntrinsics, type ResolvedJointModel } from "./joint.ts"

const name = z.string().min(1)
const HandLink = z.union([
  z.strictObject({ origin: Pose }),
  z.strictObject({ origin: Pose, joint: name,
    axis: xyz.refine((v) => Math.abs(Math.hypot(...v) - 1) < 1e-5, "unit axis required"),
    anchor: xyz, reference: z.number(),
  }),
])

// Geometry predicts references, not contacts or object acquisition. Every chain
// starts in the canonical hand frame; moving links name model joints directly.
export const HandGeometry = z.strictObject({
  description: name.optional(),
  fingers: z.record(name, z.strictObject({
    chain: z.array(HandLink).min(1),
    tip_frame: name,
    tip_offset: Pose,
  })).refine((v) => Object.keys(v).length > 0, "finger geometry required").optional(),
  center: z.strictObject({
    frame: name,
    weights: z.record(name, z.number().nonnegative())
      .refine((v) => Math.abs(Object.values(v).reduce((a, b) => a + b, 0) - 1) < 1e-8, "center weights must sum to one"),
    rotation_xyzw: quaternion,
  }).optional(),
}).superRefine((geometry, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: "custom", message })
  if (!geometry.description && !geometry.fingers) issue("geometry requires a description or fingers")
  const fingers = geometry.fingers ?? {}
  for (const finger of Object.values(fingers)) {
    const joints = finger.chain.flatMap((link) => "joint" in link ? [link.joint] : [])
    if (!joints.length || new Set(joints).size !== joints.length)
      issue("finger chain requires unique model joints")
  }
  if (geometry.center && (!geometry.fingers || Object.keys(geometry.center.weights).some((finger) => !Object.hasOwn(fingers, finger))))
    issue("center weights require declared fingers")
})

// URDF models resolve after schema parsing; run this check again at resolution.
export function handJointErrors(geometry: z.infer<typeof HandGeometry> | undefined, model: ResolvedJointModel): string[] {
  const names = new Set(model.joints.map((joint) => joint.name))
  return Object.entries(geometry?.fingers ?? {}).flatMap(([name, finger]) =>
    finger.chain.flatMap((link) => "joint" in link && !names.has(link.joint)
      ? [`finger ${name} references unknown model joint ${link.joint}`] : []))
}

export function refineHand(value: JointIntrinsics & {
  geometry?: z.infer<typeof HandGeometry>,
}, ctx: z.RefinementCtx) {
  const geometry = value.geometry
  if (!geometry) return
  const model = jointModel(value)
  const issue = (message: string) => ctx.addIssue({ code: "custom", path: ["geometry"], message })
  if (model) for (const message of handJointErrors(geometry, model)) issue(message)
}

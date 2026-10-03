import { z } from "zod"
import { Pose, quaternion, type LocalFrame } from "./common.ts"
import { ChainLink } from "./joints.ts"
import { jointModel, type JointIntrinsics, type ResolvedJointModel } from "./joint.ts"

const name = z.string().min(1)
// Match fixed-frame pose precision so schema-accepted geometry also passes FK.
const HandLink = z.intersection(ChainLink, z.object({ origin: Pose }))

// Geometry predicts references, not contacts or object acquisition. Every chain
// starts in the canonical hand frame and uses its own ordered subset of joints.
export const HandGeometry = z.strictObject({
  palm_frame: name,
  reference_frame: name,
  fingers: z.record(name, z.strictObject({
    joints: z.array(name).min(1).refine((v) => new Set(v).size === v.length, "duplicate finger joint"),
    chain: z.array(HandLink).min(1),
    tip_frame: name,
    tip_offset: Pose,
  })).refine((v) => Object.keys(v).length > 0, "finger geometry required"),
  center: z.strictObject({
    frame: name,
    weights: z.record(name, z.number().nonnegative())
      .refine((v) => Math.abs(Object.values(v).reduce((a, b) => a + b, 0) - 1) < 1e-8, "center weights must sum to one"),
    rotation_xyzw: quaternion,
  }),
})

// URDF models resolve after schema parsing; run this check again at resolution.
export function handJointErrors(geometry: z.infer<typeof HandGeometry> | undefined, model: ResolvedJointModel): string[] {
  const names = new Set(model.joints.map((joint) => joint.name))
  return Object.entries(geometry?.fingers ?? {}).flatMap(([name, finger]) =>
    finger.joints.filter((joint) => !names.has(joint)).map((joint) => `finger ${name} references unknown model joint ${joint}`))
}

export function refineHand(value: JointIntrinsics & {
  frames: Record<string, LocalFrame>,
  geometry?: z.infer<typeof HandGeometry>,
}, ctx: z.RefinementCtx) {
  const geometry = value.geometry
  if (!geometry) return
  const model = jointModel(value)
  const dynamic = [...Object.values(geometry.fingers).map((finger) => finger.tip_frame), geometry.center.frame]
  const fixed = [geometry.palm_frame, geometry.reference_frame]
  const issue = (message: string) => ctx.addIssue({ code: "custom", path: ["geometry"], message })
  if (model) for (const message of handJointErrors(geometry, model)) issue(message)
  if (new Set([...fixed, ...dynamic]).size !== fixed.length + dynamic.length) issue("hand geometry frame names must be distinct")
  for (const frame of fixed) {
    const definition = value.frames[frame]
    if (!definition?.translation_m || !definition.rotation_xyzw) issue(`declare fixed hand frame ${frame}`)
  }
  for (const finger of Object.values(geometry.fingers)) {
    const indexes = finger.chain.flatMap((link) => "joint" in link ? [link.joint] : [])
    if (indexes.length !== finger.joints.length || indexes.some((index, i) => index !== i))
      issue("finger chain must include its joints once in declared order")
  }
  const fingers = Object.keys(geometry.fingers)
  if (Object.keys(geometry.center.weights).some((finger) => !fingers.includes(finger)))
    issue("center weights reference unknown finger")
}

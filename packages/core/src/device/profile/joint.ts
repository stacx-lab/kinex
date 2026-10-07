import { z } from "zod"
import { field, Pose } from "./common.ts"
import { Joints, ChainLink, jointConfigurationErrors } from "./joints.ts"
export { Joint, jointConfigurationErrors } from "./joints.ts"

const positive = z.number().positive()

export const ResolvedJointModel = z.strictObject({ joints: Joints, chain: z.array(ChainLink).min(1).nullable() }).superRefine((model, ctx) => {
  if (!model.chain) return
  const indexes = model.chain.flatMap((link) => "joint" in link ? [link.joint] : [])
  if (indexes.length !== model.joints.length || indexes.some((n, i) => n !== i))
    ctx.addIssue({ code: "custom", path: ["chain"], message: "chain must include every joint once in declared order" })
})
export type ResolvedJointModel = z.infer<typeof ResolvedJointModel>
export const jointModelErrors = new WeakMap<object, string>()
export const resolvedJointModels = new WeakMap<object, ResolvedJointModel>()

const tolerances = { position_tolerance_m: positive, rotation_tolerance_rad: positive }
export const JointKinematics = z.strictObject({
  frame: z.string().min(1),
  fk: z.enum(["numerical", "driver"]).nullable(),
  ik: z.discriminatedUnion("backend", [
    z.strictObject({ backend: z.literal("numerical"), method: z.literal("damped_least_squares"), ...tolerances,
      max_iterations: z.number().int().positive(), damping: positive,
      budget: z.strictObject({
        max_attempts: z.number().int().positive().default(5),
        attempt_time_s: positive.default(0.02),
        max_time_s: positive.default(0.1),
      }).optional() }),
    z.strictObject({ backend: z.literal("driver"), frame_to_solver: Pose, ...tolerances }),
  ]).nullable(),
  frame_to_reported: Pose,
}).superRefine((k, ctx) => {
  if (k.ik !== null && k.fk === null)
    ctx.addIssue({ code: "custom", message: "IK verification requires FK" })
})

export const jointShape = {
  model: field(z.discriminatedUnion("format", [
    z.strictObject({ format: z.literal("urdf"), path: field(z.string().min(1)), base_link: field(z.string().min(1)), tip_link: field(z.string().min(1)) }),
    z.strictObject({ format: z.literal("serial_chain"), joints: Joints, chain: z.array(ChainLink).min(1) }),
    z.strictObject({ format: z.literal("joints"), joints: Joints }),
  ])),
  kinematics: JointKinematics.nullable().default(null),
  home: field(z.record(z.string().min(1), z.number()).nullable()),
  control: field(z.strictObject({ mode: z.literal("position"), limit_handling: z.literal("native").optional() })),
  feedback: field(z.strictObject({ velocities: z.boolean(), efforts: z.boolean() })),
  stop: field(z.strictObject({ behavior: z.enum(["hold", "halt", "controller_emergency_stop"]),
    affected_devices: z.array(z.string().min(1)).min(1).refine((v) => new Set(v).size === v.length, "affected_devices must be unique") })),
}
export type JointIntrinsics = z.infer<z.ZodObject<typeof jointShape>>

export function jointModel(value: JointIntrinsics): ResolvedJointModel | undefined {
  const model = value.model
  if (model === "???") return undefined
  if (model.format === "urdf") return resolvedJointModels.get(model)
  return { joints: model.joints, chain: model.format === "serial_chain" ? model.chain : null }
}

export function refineJoint(value: JointIntrinsics, ctx: z.RefinementCtx) {
  const model = jointModel(value)
  if (!model) return
  const result = ResolvedJointModel.safeParse(model)
  if (!result.success) for (const issue of result.error.issues) ctx.addIssue({ ...issue, path: ["model", ...issue.path] })
  for (const message of jointConfigurationErrors(value, model)) ctx.addIssue({ code: "custom", message })
  const k = value.kinematics
  if (k && !model.chain && (k.fk === "numerical" || k.ik?.backend === "numerical"))
    ctx.addIssue({ code: "custom", path: ["kinematics"], message: "numerical kinematics requires model geometry" })
}

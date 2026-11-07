import { z } from "zod"
import { ActuatorStop, field, known } from "./common.ts"

const name = z.string().min(1)
const unique = (values: readonly string[]) => new Set(values).size === values.length
// A null bound declares no limit; declared bounds include zero, the stopped command.
const bound = z.strictObject({ min: z.number(), max: z.number() })
  .refine((v) => v.min <= 0 && v.max >= 0 && v.min < v.max, "bounds must include zero").nullable()
const axes = <T extends [string, ...string[]]>(values: T) => z.partialRecord(z.enum(values), bound)
  .refine((v) => Object.keys(v).length > 0, "declare at least one axis")

// Body velocity in m/s and rad/s (si) or as [-1, 1] of the controller range (normalized).
export const VelocityLimits = z.strictObject({
  units: z.enum(["si", "normalized"]),
  axes: axes(["vx", "vy", "vz", "wx", "wy", "wz"]),
})
// Body posture offsets from the nominal stance: height in m, attitude in rad.
export const PostureLimits = axes(["height", "roll", "pitch", "yaw"])
// Each mode accepts some operations and can be left for its declared transitions.
const Mode = z.strictObject({
  description: name,
  accepts: z.array(name).refine(unique, "duplicate accepted operation"),
  transitions: z.array(name).refine(unique, "duplicate transition"),
})

export const locomotionShape = {
  velocity: field(VelocityLimits.nullable()),
  posture: field(PostureLimits.nullable()),
  modes: field(z.record(name, Mode).refine((v) => Object.keys(v).length > 0, "declare at least one mode")),
  // strict rejects commands outside the declared bounds; native leaves them to the device.
  limits: z.enum(["strict", "native"]).default("strict"),
  stop: field(ActuatorStop),
}
type LocomotionFacts = z.infer<z.ZodObject<typeof locomotionShape>> & { operations: Record<string, unknown> }

export function refineLocomotion(device: LocomotionFacts, ctx: z.RefinementCtx) {
  const { modes } = device
  if (!known(modes)) return
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path: ["modes", ...path], message })
  for (const [mode, { accepts, transitions }] of Object.entries(modes)) {
    for (const target of transitions)
      if (!Object.hasOwn(modes, target) || target === mode) issue([mode, "transitions"], `${target} must be another declared mode`)
    for (const operation of accepts) {
      if (!Object.hasOwn(device.operations, operation)) issue([mode, "accepts"], `${operation} must be a declared operation`)
      if ((operation === "velocity" || operation === "posture") && device[operation] === null)
        issue([mode, "accepts"], `${operation} requires declared ${operation} limits`)
    }
  }
}

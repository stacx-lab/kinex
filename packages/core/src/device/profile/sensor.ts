import { field } from "./common.ts"
import { z } from "zod"

const axis = z.enum(["x", "y", "z"])
const axisMap = <T extends z.ZodType>(schema: T) => z.strictObject({ x: schema.optional(), y: schema.optional(), z: schema.optional() })
const range = z.strictObject({ min: z.number(), max: z.number() }).refine((v) => v.min < v.max, "min must be below max")
export const SensorChannel = z.strictObject({
  axes: z.array(axis).min(1).refine((v) => new Set(v).size === v.length, "duplicate axis"),
  range: field(axisMap(range).nullable()),
  resolution: field(axisMap(z.number().positive()).nullable()),
  bias: field(axisMap(z.number())),
}).superRefine((channel, ctx) => {
  for (const key of ["range", "resolution", "bias"] as const) {
    const values = channel[key]
    if (values === null || values === "???") continue
    if (Object.keys(values).length !== channel.axes.length || channel.axes.some((a) => values[a] === undefined))
      ctx.addIssue({ code: "custom", path: [key], message: "must contain exactly the declared axes" })
  }
})


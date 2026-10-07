import { z } from "zod"
import { ModelValue } from "./model.ts"
import { MotionResponse } from "./response.ts"

const deviceModes = z.record(z.string().min(1), z.strictObject({
  response: MotionResponse.optional(),
  description: z.string().min(1),
  transitions: z.array(z.string().min(1)).refine(v => new Set(v).size === v.length, "duplicate transition"),
})).refine(v => Object.keys(v).length > 0, "at least one device mode is required").superRefine((value, ctx) => {
  for (const [name, state] of Object.entries(value)) {
    if (state.transitions.some(target => !Object.hasOwn(value, target)))
      ctx.addIssue({ code: "custom", path: [name, "transitions"], message: "transitions must reference declared modes" })
  }
})

export const LeggedControl = z.strictObject({
  device_modes: deviceModes.optional(),
  skills: z.record(z.string().min(1), z.string().min(1)).default({}),
  write: ModelValue.refine(value => value.type === "object" && !value.nullable, "write contract must be a non-null object"),
})

export const LeggedStop = z.strictObject({
  behavior: z.string().min(1),
  affected_devices: z.array(z.string().min(1)).min(1).refine(v => new Set(v).size === v.length, "duplicate stop member"),
})

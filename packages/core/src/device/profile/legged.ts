import { z } from "zod"
import { MotionResponse } from "./response.ts"

const identifier = z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_-]*$/)

// A closed, recursive subset of JSON Schema. Property names are identifiers;
// schemas contain no descriptions, prompts, code, or arbitrary extension keys.
type Value = { nullable?: boolean } & (
  | { type: "string"; enum?: string[]; format?: "path" | "uri"; minLength?: number; maxLength?: number }
  | { type: "number" | "integer"; minimum?: number; maximum?: number; default?: number }
  | { type: "boolean" }
  | { type: "array"; items: Value; minItems?: number; maxItems?: number }
  | { type: "object"; properties: Record<string, Value>; required: string[] }
)
const common = { nullable: z.boolean().optional() }
const numeric = {
  ...common, minimum: z.number().optional(), maximum: z.number().optional(), default: z.number().optional(),
}
const Value: z.ZodType<Value> = z.lazy(() => z.discriminatedUnion("type", [
  z.strictObject({ ...common, type: z.literal("string"), enum: z.array(z.string()).min(1).optional(), format: z.enum(["path", "uri"]).optional(), minLength: z.number().int().nonnegative().optional(), maxLength: z.number().int().nonnegative().optional() }),
  z.strictObject({ ...numeric, type: z.literal("number") }),
  z.strictObject({ ...numeric, type: z.literal("integer") }),
  z.strictObject({ ...common, type: z.literal("boolean") }),
  z.strictObject({ ...common, type: z.literal("array"), items: Value, minItems: z.number().int().nonnegative().optional(), maxItems: z.number().int().nonnegative().optional() }),
  z.strictObject({ ...common, type: z.literal("object"), properties: z.record(identifier, Value), required: z.array(identifier) }),
]).superRefine((value, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: "custom", message })
  if (value.type === "string" && value.minLength !== undefined && value.maxLength !== undefined && value.minLength > value.maxLength)
    issue("minLength must not exceed maxLength")
  if (value.type === "object" && (new Set(value.required).size !== value.required.length || value.required.some((key) => !(key in value.properties))))
    issue("required must contain unique declared property names")
  if (value.type === "array" && value.minItems !== undefined && value.maxItems !== undefined && value.minItems > value.maxItems)
    issue("minItems must not exceed maxItems")
  if (value.type !== "number" && value.type !== "integer") return
  if (value.minimum !== undefined && value.maximum !== undefined && value.minimum > value.maximum)
    issue("minimum must not exceed maximum")
  if (value.default === undefined) return
  if ((value.type === "integer" && !Number.isInteger(value.default)) || (value.minimum !== undefined && value.default < value.minimum) || (value.maximum !== undefined && value.default > value.maximum))
    issue("default must satisfy the numeric contract")
}))

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
  write: Value.refine(value => value.type === "object" && !value.nullable, "write contract must be a non-null object"),
})

export const LeggedStop = z.strictObject({
  behavior: z.string().min(1),
  affected_devices: z.array(z.string().min(1)).min(1).refine(v => new Set(v).size === v.length, "duplicate stop member"),
})

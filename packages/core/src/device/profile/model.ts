import { field, lifecycle } from "./common.ts"
import { z } from "zod"

const identifier = z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_-]*$/)
export const modelLifecycle = ["read", ...lifecycle] as const

// A closed, recursive subset of JSON Schema. Property names are identifiers;
// schemas contain no descriptions, prompts, code, or arbitrary extension keys.
export type ModelValue = { nullable?: boolean } & (
  | { type: "string"; enum?: string[]; format?: "path" | "uri"; minLength?: number; maxLength?: number }
  | { type: "number" | "integer"; minimum?: number; maximum?: number; default?: number }
  | { type: "boolean" }
  | { type: "array"; items: ModelValue; minItems?: number; maxItems?: number }
  | { type: "object"; properties: Record<string, ModelValue>; required: string[] }
)
const common = { nullable: z.boolean().optional() }
const numeric = {
  ...common, minimum: z.number().optional(), maximum: z.number().optional(), default: z.number().optional(),
}
export const ModelValue: z.ZodType<ModelValue> = z.lazy(() => z.discriminatedUnion("type", [
  z.strictObject({ ...common, type: z.literal("string"), enum: z.array(z.string()).min(1).optional(), format: z.enum(["path", "uri"]).optional(), minLength: z.number().int().nonnegative().optional(), maxLength: z.number().int().nonnegative().optional() }),
  z.strictObject({ ...numeric, type: z.literal("number") }),
  z.strictObject({ ...numeric, type: z.literal("integer") }),
  z.strictObject({ ...common, type: z.literal("boolean") }),
  z.strictObject({ ...common, type: z.literal("array"), items: ModelValue, minItems: z.number().int().nonnegative().optional(), maxItems: z.number().int().nonnegative().optional() }),
  z.strictObject({ ...common, type: z.literal("object"), properties: z.record(identifier, ModelValue), required: z.array(identifier) }),
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

export const ModelConnection = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("process"), compute: field(z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("cpu") }),
    z.strictObject({ kind: z.literal("cuda"), index: z.number().int().nonnegative() }),
    z.strictObject({ kind: z.literal("mps") }),
  ])) }),
  z.strictObject({ kind: z.literal("url"), url: field(z.url()), auth_env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).nullable().default(null) }),
])

const Artifact = z.strictObject({
  name: identifier,
  path: z.string().min(1),
  source: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("local") }),
    z.strictObject({ kind: z.literal("huggingface"), repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/), revision: z.string().min(1), filename: z.string().min(1) }),
    z.strictObject({ kind: z.literal("url"), url: z.url(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  ]),
})
const objectContract = ModelValue.refine((value) => value.type === "object" && !value.nullable, "operation input/output must be non-null objects")
export const modelShape = {
  family: field(identifier),
  variant: z.string().regex(/^[\w./:@+-]+$/).nullable().default(null),
  implementation: z.strictObject({ repository: z.url(), revision: z.string().min(1) }).nullable().default(null),
  artifacts: field(z.array(Artifact).refine((items) => new Set(items.map((item) => item.name)).size === items.length, "artifact names must be unique")),
  operations: z.array(z.strictObject({
    name: identifier.refine((name) => ![...modelLifecycle, "write", "stop", "introspect", "record_start", "record_stop"].some((reserved) => reserved === name), "reserved driver action"),
    input: objectContract,
    output: objectContract,
  })).default([]).refine((items) => new Set(items.map((item) => item.name)).size === items.length, "operation names must be unique"),
}

// The same contract drives validation for every model family. No model SDK or
// family-specific action shapes enter the tool layer.
export function modelValueSchema(value: ModelValue, defaults = true): z.ZodType {
  const schema = (() => {
    if (value.type === "string") return z.string()
      .refine((item) => !value.enum || value.enum.includes(item), "value outside enum")
      .refine((item) => value.minLength === undefined || [...item].length >= value.minLength, "string too short")
      .refine((item) => value.maxLength === undefined || [...item].length <= value.maxLength, "string too long")
      .refine((item) => value.format !== "path" || (item.length > 0 && !item.includes("\0")), "invalid path")
      .refine((item) => value.format !== "uri" || z.url().safeParse(item).success, "invalid URI")
    if (value.type === "boolean") return z.boolean()
    if (value.type === "number" || value.type === "integer") {
      const number = z.number().refine((item) => value.type !== "integer" || Number.isInteger(item), "expected integer")
        .refine((item) => value.minimum === undefined || item >= value.minimum, "below minimum")
        .refine((item) => value.maximum === undefined || item <= value.maximum, "above maximum")
      return !defaults || value.default === undefined ? number : number.default(value.default)
    }
    if (value.type === "array") return z.array(modelValueSchema(value.items, defaults))
      .refine((items) => value.minItems === undefined || items.length >= value.minItems, "too few items")
      .refine((items) => value.maxItems === undefined || items.length <= value.maxItems, "too many items")
    if (value.type === "object") return z.strictObject(Object.fromEntries(Object.entries(value.properties).map(([key, child]) => [
      key, value.required.includes(key) ? modelValueSchema(child, defaults) : modelValueSchema(child, defaults).optional(),
    ])))
    throw new Error("unsupported model value type")
  })()
  return value.nullable ? schema.nullable() : schema
}

import { z } from "zod"

export const ID = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)
export const Pointer = z.string().regex(/^\/(?:[^~]|~[01])*$/).refine(
  value => !value.split("/").some(part => ["__proto__", "prototype", "constructor"].includes(part)), "unsafe pointer",
)
export const RelativePath = z.string().min(1).refine(
  value => !value.startsWith("/") && !value.includes("\\") && !value.split("/").includes(".."), "use a path relative to .kinex",
)
export const Fact = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("profile"), device: ID.optional(), pointer: Pointer, value: z.unknown().optional() }),
  z.strictObject({ kind: z.literal("file"), path: z.string().min(1) }),
])
export type Fact = z.infer<typeof Fact>
export const Node = z.strictObject({
  id: ID, title: z.string().min(1), kind: z.enum(["prepare", "calibrate", "verify"]),
  skill: z.string().min(1), bindings: z.record(ID, ID).default({}),
  dependsOn: z.array(ID).default([]), inputs: z.array(Fact).default([]),
  outputs: z.array(Fact).default([]), optional: z.boolean().default(false),
})
export type PlanNode = z.infer<typeof Node>
export const Task = z.strictObject({
  objective: z.string().min(1), targets: z.array(ID).default([]),
  facts: z.array(Fact).default([]),
})
export const Plan = z.strictObject({ version: z.literal(1), nodes: z.array(Node), task: Task.nullable().default(null) })
export type Plan = z.infer<typeof Plan>
export const Outcome = z.strictObject({
  status: z.enum(["done", "partial", "failed", "needs-input"]),
  note: z.string().min(1), evidence: z.array(RelativePath).min(1),
})
export type Outcome = z.infer<typeof Outcome>
export const Receipt = Outcome.extend({
  at: z.string(), definition: z.string(), inputs: z.string(), outputs: z.string(), evidenceHash: z.string(), dependencies: z.string(),
})
export const StoredPlan = Plan.extend({ revision: z.number().int().nonnegative(), receipts: z.record(ID, Receipt).default({}) })
export type StoredPlan = z.infer<typeof StoredPlan>

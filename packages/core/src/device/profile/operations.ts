import { z } from "zod"

const endpoint = z.string().regex(/^\/?[A-Za-z_]\w*(?:\/[A-Za-z_]\w*)*$/, "ROS endpoint must have valid name tokens")
const type = z.string().regex(/^[A-Za-z]\w*\/(msg|srv)\/[A-Za-z]\w*$/)
export const Operation = z.strictObject({
  description: z.string().describe("Operation-specific inputs, outputs, units, frames, timing and behavior; may be empty"),
  transport: z.enum(["topic", "service"]),
  direction: z.enum(["input", "output"]),
  endpoint,
  type,
  qos: z.strictObject({
    depth: z.number().int().min(1).max(1024).default(1),
    reliability: z.enum(["reliable", "best_effort"]).default("reliable"),
    durability: z.enum(["volatile", "transient_local"]).default("volatile"),
  }).prefault({}),
  timeout_s: z.number().positive().default(10),
  motion: z.strictObject({ acquire: endpoint, stop: endpoint, status: endpoint }).optional(),
  cancellation: z.strictObject({ endpoint, type }).optional(),
}).superRefine((op, ctx) => {
  if (op.transport === "service" && (op.direction !== "input" || !op.type.includes("/srv/")))
    ctx.addIssue({ code: "custom", message: "services are device inputs and require a srv type" })
  if (op.transport === "topic" && !op.type.includes("/msg/"))
    ctx.addIssue({ code: "custom", message: "topics require a msg type" })
  if (op.cancellation && (op.transport !== "service" || !op.cancellation.type.includes("/srv/")))
    ctx.addIssue({ code: "custom", message: "cancellation requires a service operation and srv type" })
  if (op.motion && (op.transport !== "topic" || op.direction !== "input"))
    ctx.addIssue({ code: "custom", message: "managed motion requires an input topic" })
})
export type Operation = z.infer<typeof Operation>

export const RosRuntime = z.strictObject({
  interpreter: z.string().min(1).optional(),
  overlays: z.array(z.string().min(1)).default([]),
  domain_id: z.number().int().min(0).max(232).default(0),
  namespace: z.string().regex(/^(?:\/?[A-Za-z_]\w*(?:\/[A-Za-z_]\w*)*|\/|)$/).default(""),
  observation: z.string().min(1).optional(),
  nodes: z.array(z.strictObject({ entry: z.string().min(1), factory: z.string().default("create") })).default([]),
  ready_timeout_s: z.number().positive().default(30),
})
export type RosRuntime = z.infer<typeof RosRuntime>

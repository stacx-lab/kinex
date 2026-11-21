import { z } from "zod"
import { define } from "@kinex/core/tool/tool"
import { ID, Outcome, Plan, Task } from "../planning/schema.ts"
import { fail } from "../planning/facts.ts"
import { inspectPlan, readPlan, savePlan, selectTask, recordOutcome, renderSetup } from "../planning/plan.ts"
import DESCRIPTION from "./setup_plan.txt"
import FORMAT from "./setup_plan_format.txt"

// The plan, task and outcome shapes stay out of the model's tool list: the planning
// schemas validate them here, and a full read returns their format.
const record = z.record(z.string(), z.unknown())
const format = (error: z.ZodError) => error.issues.map(issue => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")

export const SetupPlanTool = define("setup_plan", {
  description: DESCRIPTION,
  parameters: z.strictObject({
    action: z.enum(["read", "save", "select", "record"]),
    full: z.boolean().default(false).describe("read: every node, the procedure descriptors and the plan format"),
    revision: z.number().int().nonnegative().optional().describe("save, select, record: the revision last read"),
    plan: record.optional().describe("save: {version: 1, nodes, task?}"),
    task: record.nullable().optional().describe("select: {objective, targets, facts?}, or null"),
    node: ID.optional().describe("record: the node's ID"),
    outcome: record.optional().describe("record: {status, note, evidence}"),
  }),
  execute: async (args, ctx) => {
    if (args.action !== "read") {
      const { revision } = args
      if (revision === undefined) fail(`${args.action} needs the revision last read`)
      await ctx.ask({ permission: "setup_plan", description: `${args.action} setup plan` })
      ctx.abort.throwIfAborted()
      try {
        if (args.action === "save") await savePlan(ctx.directory, Plan.parse(args.plan), revision)
        if (args.action === "select") await selectTask(ctx.directory, args.task === null ? null : Task.parse(args.task), revision)
        if (args.action === "record") await recordOutcome(ctx.directory, ID.parse(args.node), Outcome.parse(args.outcome), revision)
      } catch (error) {
        if (!(error instanceof z.ZodError)) throw error
        fail(`invalid ${args.action}: ${format(error)}. Read with full:true for the plan format.`)
      }
    }
    const view = await inspectPlan(ctx.directory)
    const full = args.action === "read" && args.full
    return { title: view.taskSatisfied ? "Task prerequisites satisfied" : "Setup plan",
      output: renderSetup(view, full ? FORMAT.trim() : undefined), metadata: { ...(full ? { plan: await readPlan(ctx.directory) } : {}), revision: view.revision } }
  },
})

import { z } from "zod"
import { define } from "@kinex/core/tool/tool"
import { Plan, Task, Outcome, ID } from "../planning/schema.ts"
import { inspectPlan, readPlan, savePlan, selectTask, recordOutcome, renderSetup } from "../planning/plan.ts"
import DESCRIPTION from "./setup_plan.txt"

export const SetupPlanTool = define("setup_plan", {
  description: DESCRIPTION,
  parameters: z.discriminatedUnion("action", [
    z.strictObject({ action: z.literal("read"), full: z.boolean().default(false) }),
    z.strictObject({ action: z.literal("save"), revision: z.number().int().nonnegative(), plan: Plan }),
    z.strictObject({ action: z.literal("select"), revision: z.number().int().nonnegative(), task: Task.nullable() }),
    z.strictObject({ action: z.literal("record"), revision: z.number().int().nonnegative(), node: ID, outcome: Outcome }),
  ]),
  execute: async (args, ctx) => {
    if (args.action !== "read") {
      await ctx.ask({ permission: "setup_plan", description: `${args.action} setup plan` })
      ctx.abort.throwIfAborted()
      if (args.action === "save") await savePlan(ctx.directory, args.plan, args.revision)
      if (args.action === "select") await selectTask(ctx.directory, args.task, args.revision)
      if (args.action === "record") await recordOutcome(ctx.directory, args.node, args.outcome, args.revision)
    }
    const view = await inspectPlan(ctx.directory)
    const full = args.action === "read" && args.full
    return { title: view.taskSatisfied ? "Task prerequisites satisfied" : "Setup plan",
      output: renderSetup(view, full), metadata: { ...(full ? { plan: await readPlan(ctx.directory) } : {}), revision: view.revision } }
  },
})

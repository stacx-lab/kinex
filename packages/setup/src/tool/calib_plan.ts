import { z } from "zod"
import { define } from "@kinex/core/tool/tool"
import { calibrationPlan, renderPlan } from "../calibration/plan.ts"
import DESCRIPTION from "./calib_plan.txt"

export const CalibPlanTool = define("calib_plan", {
  description: DESCRIPTION,
  parameters: z.object({
    full: z.boolean().default(false).describe("render every item with details; the default collapses done/blocked items to one line each"),
  }),
  execute: async (args, ctx) => {
    const plan = await calibrationPlan(ctx.directory)
    return {
      title: plan.robotID
        ? `calibration ${plan.counts.done}/${plan.items.length} done for ${plan.robotID}`
        : "no robot onboarded",
      output: renderPlan(plan, { full: args.full }),
    }
  },
})

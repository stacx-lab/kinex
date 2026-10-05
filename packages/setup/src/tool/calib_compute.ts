import { define } from "@kinex/core/tool/tool"
import { compute, ComputeInput } from "../calibration/compute.ts"
import DESCRIPTION from "./calib_compute.txt"

export const CalibComputeTool = define("calib_compute", {
  description: DESCRIPTION, parameters: ComputeInput, recordingOrigin: "agent",
  execute: async (args, ctx) => {
    await ctx.ask({ permission: "calib_compute", description: `compute ${args.operation}` })
    ctx.abort.throwIfAborted()
    const result = await compute(ctx.directory, args, ctx.abort)
    return { title: `${args.operation}: ${result.quality}`, output: JSON.stringify(result, null, 2),
      isError: result.computation === "failed" || result.quality === "failed" }
  },
})

import type { KinexRuntime, ToolInvocation, Def } from "@kinex/core"
import { toModelSchema } from "@kinex/core/tool/registry"
import { calibrationPlan, renderPlan } from "./calibration/plan.ts"
import { CalibPlanTool } from "./tool/calib_plan.ts"
import { CalibSampleTool } from "./tool/calib_sample.ts"
import { DeviceCalibrateTool } from "./tool/device_calibrate.ts"
import INSTRUCTIONS from "./instructions.txt"

const tools: readonly Def[] = [CalibPlanTool, CalibSampleTool, DeviceCalibrateTool]
export const setupToolNames: readonly string[] = tools.map(tool => tool.id)

/** Borrows the core runtime; construction has no filesystem or device effects. */
export function createKinexSetup(runtime: KinexRuntime) {
  const directory = runtime.directory
  return {
    calibration: { plan: () => runtime.operation(() => calibrationPlan(directory)) },
    tools: {
      list: () => runtime.operation(async () => ({ tools: tools.map(toModelSchema), problems: [] as string[] })),
      call(name: string, input: unknown, call: ToolInvocation) {
        const def = tools.find(tool => tool.id === name)
        if (!def) throw new Error(`unknown setup tool "${name}"`)
        return runtime.tools.execute(def, input, call)
      },
    },
    context: () => runtime.operation(async () => ({
      instructions: INSTRUCTIONS,
      sections: {
        calibration: renderPlan(await calibrationPlan(directory)),
      },
    })),
  }
}
export type KinexSetup = ReturnType<typeof createKinexSetup>

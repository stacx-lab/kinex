import type { KinexRuntime, ToolInvocation, Def } from "@kinex/core"
import { toModelSchema } from "@kinex/core/tool/registry"
import { inspectPlan, savePlan, selectTask, recordOutcome } from "./planning/plan.ts"
import type { Plan, Outcome } from "./planning/schema.ts"
import { SetupPlanTool } from "./tool/setup_plan.ts"
import { CalibSampleTool } from "./tool/calib_sample.ts"
import { CalibComputeTool } from "./tool/calib_compute.ts"
import INSTRUCTIONS from "./instructions.txt"

const tools: readonly Def[] = [SetupPlanTool, CalibSampleTool, CalibComputeTool]
export const setupToolNames: readonly string[] = tools.map(tool => tool.id)

/** Borrows the core runtime; construction has no filesystem or device effects. */
export function createKinexSetup(runtime: KinexRuntime) {
  const directory = runtime.directory
  return {
    plan: {
      inspect: () => runtime.operation(() => inspectPlan(directory)),
      save: (plan: Plan, revision: number) => runtime.operation(() => savePlan(directory, plan, revision)),
      select: (task: Plan["task"], revision: number) => runtime.operation(() => selectTask(directory, task, revision)),
      record: (node: string, outcome: Outcome, revision: number) => runtime.operation(() => recordOutcome(directory, node, outcome, revision)),
    },
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
      sections: {},
    })),
  }
}
export type KinexSetup = ReturnType<typeof createKinexSetup>

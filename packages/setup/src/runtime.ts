import type { KinexRuntime, ToolInvocation, Def } from "@kinex/core"
import { ProfileStore } from "@kinex/core/device/profile/store"
import { deviceTransition } from "@kinex/core/device/lifecycle"
import { deactivateDevice } from "@kinex/core/device/dispatch"
import { toModelSchema } from "@kinex/core/tool/registry"
import { calibrationPlan, renderPlan } from "./calibration/plan.ts"
import { removeDevice } from "./calibration/store.ts"
import { listDeviceTemplates, deviceContentRoots } from "./templates.ts"
import { CalibPlanTool } from "./tool/calib_plan.ts"
import { CalibWriteTool } from "./tool/calib_write.ts"
import { CalibSampleTool } from "./tool/calib_sample.ts"
import { DeviceCalibrateTool } from "./tool/device_calibrate.ts"
import INSTRUCTIONS from "./instructions.txt"

const tools: readonly Def[] = [CalibPlanTool, CalibWriteTool, CalibSampleTool, DeviceCalibrateTool]
export const setupToolNames: readonly string[] = tools.map(tool => tool.id)

/** Borrows the core runtime; construction has no filesystem or device effects. */
export function createKinexSetup(runtime: KinexRuntime) {
  const directory = runtime.directory
  return {
    calibration: { plan: () => runtime.operation(() => calibrationPlan(directory)) },
    devices: {
      list: runtime.devices.list,
      templates: () => runtime.operation(() => listDeviceTemplates(directory)),
      unregister: (name: string, signal?: AbortSignal) => runtime.operation(abort => deviceTransition(directory, name, async () => {
        abort.throwIfAborted()
        const device = await ProfileStore.readDevice(directory, name)
        if (!device) throw new Error(`unknown device "${name}"`)
        await deactivateDevice(directory, device)
        abort.throwIfAborted()
        await removeDevice(directory, name)
      }), signal),
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
      sections: {
        guides: `Device setup guide roots (nearest first): ${(await deviceContentRoots(directory)).join(", ")}`,
        calibration: renderPlan(await calibrationPlan(directory)),
      },
    })),
  }
}
export type KinexSetup = ReturnType<typeof createKinexSetup>

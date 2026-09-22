import { z } from "zod"
import { define } from "../tool.ts"
import { noRobot, unknownDevice, unloadedDevice, dispatchDevice, renderReading } from "./shared.ts"
import { CalibrationStore } from "../../calibration/store.ts"
import { lifecycleAction } from "../../device/lifecycle.ts"
import { isCommandAction } from "../../device/interface.ts"
import { imageMime } from "../../util/media.ts"
import DESCRIPTION from "./device.txt"

// The one agent-facing dispatch onto a device's driver interface. The action
// decides the permission path: commands (isCommandAction) always ask as
// "device_act"; reads ask as "device_read" only when a driver runs (mock
// reads are harness-internal). Lifecycle actions use device_act on every type.
export const DeviceTool = define("device", {
  description: DESCRIPTION,
  parameters: z.object({
    deviceID: z.string().describe("device name from the <robot> block, e.g. arm, wrist_cam"),
    action: z.string().default("read").describe('driver action to run (see the device type\'s interface), e.g. "read", "write", "detect", "load", "unload"'),
    args: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("JSON arguments for the action — commands use the DEVICE'S OWN action space (see its type's profile contract; joint devices derive joints from their model)"),
    compact: z.boolean().default(false).describe("single-line JSON output — use in polling/sampling loops"),
    verbose: z.boolean().default(true).describe("keep all result fields; false omits empty optional feedback"),
  }),
  execute: async (args, ctx) => {
    const robot = await CalibrationStore.readManifest(ctx.directory)
    if (!robot) return noRobot()
    const device = await CalibrationStore.readDevice(ctx.directory, args.deviceID)
    if (!device) return unknownDevice(args.deviceID)
    const lifecycle = args.action === "load" || args.action === "unload"
    if (!lifecycle && args.action !== "status" && !device.loaded) return unloadedDevice(device)
    if (lifecycle && Object.keys(args.args ?? {}).length)
      return { title: "invalid lifecycle arguments", output: "load/unload accept no arguments", isError: true }
    const command = lifecycle || isCommandAction(device, args.action)
    const intent = `${args.action} on ${device.name}${args.args ? ` ${JSON.stringify(args.args)}` : ""}`
    if (command) await ctx.ask({ permission: "device_act", description: intent })
    else if (device.access?.driver)
      await ctx.ask({ permission: "device_read", description: `run ${device.access.driver.entry} ${args.action} on ${device.name}` })
    const reading = args.action === "load" || args.action === "unload"
      ? await lifecycleAction(ctx.directory, device, args.action, ctx.abort)
      : await dispatchDevice(ctx.directory, device, args.action, args.args ?? {}, undefined, ctx.abort)
    const output = renderReading(reading, args.verbose || !["read", "write"].includes(args.action), args.compact)
    const mime = reading.filePath ? await imageMime(reading.filePath) : undefined
    const attachments = mime && reading.filePath ? [{ mime, path: reading.filePath }] : undefined
    return { title: command ? intent : `device ${device.name}`, output, attachments }
  },
})

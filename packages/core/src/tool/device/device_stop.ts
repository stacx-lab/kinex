import { stopDevices } from "../../device/stop.ts"
import { z } from "zod"
import { define } from "../tool.ts"
import { noRobot } from "./shared.ts"
import { ProfileStore } from "../../device/profile/store.ts"
import { known, isActuated } from "../../device/profile/schema.ts"
import DESCRIPTION from "./device_stop.txt"

// Deliberately never permission-gated: a stop must not wait on a prompt.
export const DeviceStopTool = define("device_stop", {
  description: DESCRIPTION,
  recordingOrigin: "agent",
  parameters: z.object({
    deviceID: z.string().optional().describe("device to stop; omit to stop every loaded actuated device"),
    reason: z.string().optional().describe("why the stop was triggered"),
  }),
  execute: async (args, ctx) => {
    const robot = await ProfileStore.readManifest(ctx.directory)
    if (!robot) return noRobot()
    const devices = await ProfileStore.listDevices(ctx.directory)
    const targets = devices.filter((device) =>
      args.deviceID
        ? device.name === args.deviceID
        : device.loaded && isActuated(device),
    )
    if (targets.length === 0)
      return {
        title: "nothing to stop",
        output: args.deviceID ? `no device "${args.deviceID}"` : "no loaded actuated devices",
        isError: args.deviceID !== undefined,
      }
    const outcomes = await stopDevices(ctx.directory, targets)
    const lines = outcomes.map((outcome, index) => {
      if ("error" in outcome) return `${outcome.device}: ${outcome.error}`
      const device = targets[index]!
      const stop = "stop" in device.intrinsics ? device.intrinsics.stop : undefined
      const scope = stop && known(stop) ? ` (${stop.behavior}; affects ${stop.affected_devices.join(", ")})` : ""
      return `${device.name}: stopped${scope}`
    })
    return {
      title: `stop${args.reason ? ` (${args.reason})` : ""}`,
      output: lines.join("\n"),
      isError: lines.some((line) => line.includes("NO STOP PATH") || line.includes("STOP FAILED")),
    }
  },
})

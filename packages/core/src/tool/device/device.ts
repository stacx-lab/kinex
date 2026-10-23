import { z } from "zod"
import { define } from "../tool.ts"
import { renderReading } from "./shared.ts"
import { callDevices, DeviceCallSchema } from "./calls.ts"
import DESCRIPTION from "./device.txt"
import { failureMetadata, renderFailure } from "../errors.ts"

export const DeviceTool = define("device", {
  description: DESCRIPTION,
  recordingOrigin: "agent",
  parameters: DeviceCallSchema.extend({
    compact: z.boolean().default(false).describe("single-line JSON output — use in polling/sampling loops"),
  }),
  execute: async (args, ctx) => {
    const [result] = await callDevices([args], ctx)
    if (!result?.ok) return { title: `device ${args.deviceID}`,
      output: renderFailure({ error: result?.error ?? "device call failed", ...failureMetadata({ ...result }) }), isError: true }
    const reading = { deviceID: args.deviceID,
      data: result.attachments ? { deviceID: args.deviceID, ...result.data } : result.data, filePath: result.file }
    const output = renderReading(reading, args.compact)
    return { title: `${args.action} on ${args.deviceID}`, output, ...(result.attachments ? { attachments: result.attachments } : {}) }
  },
})

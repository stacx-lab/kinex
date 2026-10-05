import { z } from "zod"
import { define } from "../tool.ts"
import { renderReading } from "./shared.ts"
import { imageMime } from "../../util/media.ts"
import { callDevices, DeviceCallSchema } from "./calls.ts"
import DESCRIPTION from "./device.txt"

export const DeviceTool = define("device", {
  description: DESCRIPTION,
  recordingOrigin: "agent",
  parameters: DeviceCallSchema.extend({
    compact: z.boolean().default(false).describe("single-line JSON output — use in polling/sampling loops"),
    verbose: z.boolean().default(true).describe("keep all result fields; false omits empty optional feedback"),
  }),
  execute: async (args, ctx) => {
    const [result] = await callDevices([args], ctx)
    if (!result?.ok) return { title: `device ${args.deviceID}`, output: result?.error ?? "device call failed", isError: true }
    const reading = { deviceID: args.deviceID, kind: args.action, data: result.data, filePath: result.file }
    const output = renderReading(reading, args.verbose || !["read", "write"].includes(args.action), args.compact)
    const mime = reading.filePath ? await imageMime(reading.filePath) : undefined
    const attachments = mime && reading.filePath ? [{ mime, path: reading.filePath }] : undefined
    return { title: `${args.action} on ${args.deviceID}`, output, attachments }
  },
})

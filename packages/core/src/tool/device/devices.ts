import { define } from "../tool.ts"
import { formatJSON } from "../../util/json.ts"
import { imageMime } from "../../util/media.ts"
import { callDevices, DeviceCallsSchema } from "./calls.ts"
import DESCRIPTION from "./devices.txt"

export const DevicesTool = define("devices", {
  description: DESCRIPTION,
  parameters: DeviceCallsSchema,
  execute: async (args, ctx) => {
    const results = await callDevices(args.calls, ctx)
    const attachments = []
    for (const result of results) {
      const mime = result.file ? await imageMime(result.file) : undefined
      if (mime && result.file) attachments.push({ mime, path: result.file })
    }
    return { title: `devices: ${args.calls.length} calls`, output: formatJSON({ results }),
      isError: results.some(result => !result.ok), attachments }
  },
})

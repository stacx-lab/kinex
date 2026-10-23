import { z } from "zod"
import { ProfileStore } from "../../device/profile/store.ts"
import { checkDeviceCall, dispatchDevice } from "../../device/dispatch.ts"
import { lifecycleAction } from "../../device/lifecycle.ts"
import { isCommandAction } from "../../device/interface.ts"
import { NamedError } from "../../util/error.ts"
import { imageMime } from "../../util/media.ts"
import type { Attachment, Context } from "../tool.ts"
import { failure, type Failure } from "../errors.ts"

export const DeviceCallSchema = z.strictObject({
  deviceID: z.string().min(1),
  action: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({}),
})
export const DeviceCallsSchema = z.strictObject({ calls: z.array(DeviceCallSchema).min(1) })
type Call = z.infer<typeof DeviceCallSchema>
export interface CallResult extends Partial<Failure> {
  deviceID: string
  action: string
  ok: boolean
  data?: Record<string, unknown>
  file?: string
  attachments?: Attachment[]
}
class DeviceCallError extends NamedError {
  constructor(message: string) { super("DeviceCallError", message) }
}

export async function callDevices(calls: Call[], ctx: Context): Promise<CallResult[]> {
  const robot = await ProfileStore.readManifest(ctx.directory)
  if (!robot) throw new DeviceCallError("No robot is configured. Configure the workspace manifest and device profiles first.")
  const prepared = await Promise.all(calls.map(async call => {
    try {
      const device = await ProfileStore.readDevice(ctx.directory, call.deviceID)
      if (!device) throw new DeviceCallError(`no device "${call.deviceID}" in this workspace`)
      checkDeviceCall(device, call.action, call.args)
      return { call, device, command: call.action === "load" || call.action === "unload" || isCommandAction(device, call.action) }
    } catch (error) { return { call, failure: failure(error) } }
  }))
  for (const item of prepared) {
    ctx.abort.throwIfAborted()
    if (!item.device) continue
    await ctx.ask({
      permission: item.command ? "device_act" : "device_read",
      description: `${item.call.action} on ${item.device.name} ${JSON.stringify(item.call.args)}`,
    })
  }
  ctx.abort.throwIfAborted()
  return Promise.all(prepared.map(async item => {
    const { deviceID, action, args } = item.call
    if (!item.device) return { deviceID, action, ok: false, ...item.failure }
    try {
      ctx.abort.throwIfAborted()
      const reading = action === "load" || action === "unload"
        ? await lifecycleAction(ctx.directory, item.device, action, ctx.abort)
        : await dispatchDevice(ctx.directory, item.device, action, args, undefined, ctx.abort)
      ctx.abort.throwIfAborted()
      const { data, filePath: file } = reading
      const mime = file && await imageMime(file)
      return { deviceID, action, ok: true, ...(data ? { data } : {}), ...(file ? { file } : {}),
        ...(file && mime ? { attachments: [{ mime, path: file }] } : {}) }
    } catch (error) {
      ctx.abort.throwIfAborted()
      return { deviceID, action, ok: false, ...failure(error) }
    }
  }))
}

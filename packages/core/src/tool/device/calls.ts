import { z } from "zod"
import { CalibrationStore } from "../../calibration/store.ts"
import { dispatchDevice } from "../../device/dispatch.ts"
import { lifecycleAction } from "../../device/lifecycle.ts"
import { isCommandAction } from "../../device/interface.ts"
import { NamedError } from "../../util/error.ts"
import type { Context } from "../tool.ts"

export const DeviceCallSchema = z.strictObject({
  deviceID: z.string().min(1),
  action: z.string().default("read"),
  args: z.record(z.string(), z.unknown()).default({}),
})
export const DeviceCallsSchema = z.strictObject({ calls: z.array(DeviceCallSchema).min(1) })
type Call = z.infer<typeof DeviceCallSchema>
interface Options {
  kind?: "perception" | "controller"
  owner?: string
  authorize?: boolean
}
export interface CallResult {
  deviceID: string
  action: string
  ok: boolean
  data?: Record<string, unknown>
  file?: string
  error?: string
}
class DeviceCallError extends NamedError {
  constructor(message: string) { super("DeviceCallError", message) }
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

export async function callDevices(calls: Call[], ctx: Context, options: Options = {}): Promise<CallResult[]> {
  const robot = await CalibrationStore.readManifest(ctx.directory)
  if (!robot) throw new DeviceCallError("No robot is configured. Run /onboarding first.")
  const prepared = await Promise.all(calls.map(async call => {
    try {
      const device = await CalibrationStore.readDevice(ctx.directory, call.deviceID)
      if (!device) throw new DeviceCallError(`no device "${call.deviceID}" in this workspace`)
      const lifecycle = call.action === "load" || call.action === "unload"
      if (options.kind && lifecycle) throw new DeviceCallError("load/unload are unavailable inside Python tools; use the device tool")
      if (!lifecycle && call.action !== "status" && !device.loaded) throw new DeviceCallError(`device "${device.name}" is unloaded`)
      if (lifecycle && Object.keys(call.args).length) throw new DeviceCallError("load/unload accept no arguments")
      const command = lifecycle || isCommandAction(device, call.action)
      if (options.kind === "perception" && command) throw new DeviceCallError(`perception tools may not command a device (${call.action} on ${device.name})`)
      return { call, device, command }
    } catch (error) { return { call, error: message(error) } }
  }))
  for (const item of prepared) {
    ctx.abort.throwIfAborted()
    if (!item.device || options.authorize === false) continue
    if (item.command || item.device.access?.driver) await ctx.ask({
      permission: item.command ? "device_act" : "device_read",
      description: `${item.call.action} on ${item.device.name} ${JSON.stringify(item.call.args)}`,
    })
  }
  ctx.abort.throwIfAborted()
  return Promise.all(prepared.map(async item => {
    const { deviceID, action, args } = item.call
    if (!item.device) return { deviceID, action, ok: false, error: item.error }
    try {
      ctx.abort.throwIfAborted()
      const reading = action === "load" || action === "unload"
        ? await lifecycleAction(ctx.directory, item.device, action, ctx.abort)
        : await dispatchDevice(ctx.directory, item.device, action, args, options.owner, ctx.abort)
      ctx.abort.throwIfAborted()
      return { deviceID, action, ok: true, ...(reading.data ? { data: reading.data } : {}), ...(reading.filePath ? { file: reading.filePath } : {}) }
    } catch (error) {
      ctx.abort.throwIfAborted()
      return { deviceID, action, ok: false, error: message(error) }
    }
  }))
}

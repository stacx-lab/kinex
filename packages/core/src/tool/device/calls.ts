import { z } from "zod"
import { readFile } from "node:fs/promises"
import { ProfileStore } from "../../device/profile/store.ts"
import { dispatchDevice } from "../../device/dispatch.ts"
import { lifecycleAction } from "../../device/lifecycle.ts"
import { isCommandAction } from "../../device/interface.ts"
import { NamedError } from "../../util/error.ts"
import { imageMimeBytes } from "../../util/media.ts"
import type { Attachment, Context } from "../tool.ts"
import { failure, type Failure } from "../errors.ts"

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

export async function callDevices(calls: Call[], ctx: Context, options: Options = {}): Promise<CallResult[]> {
  const robot = await ProfileStore.readManifest(ctx.directory)
  if (!robot) throw new DeviceCallError("No robot is configured. Configure the workspace manifest and device profiles first.")
  const prepared = await Promise.all(calls.map(async call => {
    try {
      const device = await ProfileStore.readDevice(ctx.directory, call.deviceID)
      if (!device) throw new DeviceCallError(`no device "${call.deviceID}" in this workspace`)
      const camera = (device.type === "rgb" || device.type === "rgbd") && call.action === "read"
      if (!options.kind && camera)
        call = { ...call, args: { output: "base64", ...call.args } }
      const lifecycle = call.action === "load" || call.action === "unload"
      if (options.kind && lifecycle) throw new DeviceCallError("load/unload are unavailable inside Python tools; use the device tool")
      if (!lifecycle && call.action !== "status" && !device.loaded) throw new DeviceCallError(`device "${device.name}" is unloaded`)
      if (lifecycle && Object.keys(call.args).length) throw new DeviceCallError("load/unload accept no arguments")
      const command = lifecycle || isCommandAction(device, call.action)
      if (options.kind === "perception" && command) throw new DeviceCallError(`perception tools may not command a device (${call.action} on ${device.name})`)
      return { call, device, command, camera }
    } catch (error) { return { call, failure: failure(error) } }
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
    if (!item.device) return { deviceID, action, ok: false, ...item.failure }
    try {
      ctx.abort.throwIfAborted()
      const reading = action === "load" || action === "unload"
        ? await lifecycleAction(ctx.directory, item.device, action, ctx.abort)
        : await dispatchDevice(ctx.directory, item.device, action, args, options.owner, ctx.abort)
      ctx.abort.throwIfAborted()
      if (item.camera && !options.kind) {
        const data = reading.data?.color !== undefined
          ? z.string().base64().parse(reading.data.color)
          : (await readFile(z.string().parse(reading.filePath))).toString("base64")
        if (imageMimeBytes(Buffer.from(data.slice(0, 32), "base64")) !== "image/png")
          throw new DeviceCallError("Camera read did not return a PNG image")
        return { deviceID, action, ok: true,
          data: reading.filePath ? reading.data : { timestamp: reading.data?.timestamp },
          ...(reading.filePath ? { file: reading.filePath } : {}),
          attachments: [{ mime: "image/png", data }] }
      }
      return { deviceID, action, ok: true, ...(reading.data ? { data: reading.data } : {}), ...(reading.filePath ? { file: reading.filePath } : {}) }
    } catch (error) {
      ctx.abort.throwIfAborted()
      return { deviceID, action, ok: false, ...failure(error) }
    }
  }))
}

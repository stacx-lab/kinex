import { scoped } from "../scope.ts"
import { shortID } from "../util/id.ts"
import { NamedError } from "../util/error.ts"
import { ProfileStore } from "./profile/store.ts"
import { type Device } from "./profile/schema.ts"
import { dispatchDevice } from "./dispatch.ts"
import { rosReady } from "./ros.ts"

// Running Python invocations and the devices each has commanded, keyed by device
// directory: a failed invocation stops them, and a stop cancels the invocation.
interface Invocation { cancel: AbortController; devices: Map<string, Device> }
const invocations = scoped(() => new Map<string, Invocation>())

export function registerInvocation(cancel: AbortController): string {
  const id = shortID()
  invocations().set(id, { cancel, devices: new Map() })
  return id
}

export async function enrollDevice(cwd: string, id: string, name: string) {
  const device = await ProfileStore.readDevice(cwd, name)
  if (!device?.runtime || !await rosReady(cwd, device)) throw new NamedError("DeviceInactiveError", `${name} is not ready`)
  invocations().get(id)?.devices.set(await ProfileStore.deviceDir(cwd, name), device)
}

/** Ends an invocation; after a failure, stops every device it commanded. */
export async function releaseInvocation(cwd: string, id: string, failed: boolean) {
  const invocation = invocations().get(id)
  invocations().delete(id)
  if (!failed || !invocation?.devices.size) return
  const errors = (await sendStops(cwd, [...invocation.devices.values()])).flatMap(outcome => "error" in outcome ? [outcome.error] : [])
  if (errors.length) throw new NamedError("DeviceCleanupError", `invocation cleanup failed: ${errors.join("; ")}`)
}

/** Stops devices and cancels the running invocations that commanded any of them. */
export async function stopDevices(cwd: string, devices: Device[]) {
  const directories = new Set(await Promise.all(devices.map(device => ProfileStore.deviceDir(cwd, device.name))))
  for (const { cancel, devices: commanded } of invocations().values())
    if ([...commanded.keys()].some(directory => directories.has(directory)))
      cancel.abort(new NamedError("DeviceStopped", "a device stop cancelled this invocation"))
  return sendStops(cwd, devices)
}

function sendStops(cwd: string, devices: Device[]) {
  return Promise.all(devices.map(async (device) => {
    const signal = AbortSignal.timeout(Math.ceil((device.operations.stop?.timeout_s ?? 30) * 1000))
    return dispatchDevice(cwd, device, "stop", {}, undefined, signal).then(
      (reading) => ({ device: device.name, reading }),
      (error: unknown) => ({ device: device.name, error: `STOP FAILED — ${error instanceof Error ? error.message : String(error)}` }),
    )
  }))
}

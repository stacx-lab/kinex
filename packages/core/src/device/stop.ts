import { type Device } from "./profile/schema.ts"
import { dispatchDevice } from "./dispatch.ts"

export async function stopDevices(cwd: string, devices: Device[]) {
  return Promise.all(devices.map(async (device) => {
    const signal = AbortSignal.timeout(Math.ceil((device.operations.stop?.timeout_s ?? 30) * 1000))
    return dispatchDevice(cwd, device, "stop", {}, undefined, signal).then(
      (reading) => ({ device: device.name, reading }),
      (error: unknown) => ({ device: device.name, error: `STOP FAILED — ${error instanceof Error ? error.message : String(error)}` }),
    )
  }))
}

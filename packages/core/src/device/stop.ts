import { ProfileStore } from "./profile/store.ts"
import { type Device } from "./profile/schema.ts"
import { dispatchDevice } from "./dispatch.ts"

export async function stopDevices(cwd: string, targets?: Device[]) {
  const devices = targets ?? (await ProfileStore.listDevices(cwd)).filter((device) => device.loaded && (device.operations.stop || Object.values(device.operations).some(op => op.motion)))
  return Promise.all(devices.map(async (device) => {
    const signal = AbortSignal.timeout(Math.ceil((device.operations.stop?.timeout_s ?? 30) * 1000))
    return dispatchDevice(cwd, device, "stop", {}, undefined, signal).then(
      (reading) => ({ device: device.name, reading }),
      (error: unknown) => ({ device: device.name, error: `STOP FAILED — ${error instanceof Error ? error.message : String(error)}` }),
    )
  }))
}

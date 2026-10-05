import { ProfileStore } from "./profile/store.ts"
import { isActuated, known, type Device } from "./profile/schema.ts"
import { dispatchDevice } from "./dispatch.ts"

export async function stopDevices(cwd: string, targets?: Device[]) {
  const devices = targets ?? (await ProfileStore.listDevices(cwd)).filter((device) => device.loaded && isActuated(device))
  return Promise.all(devices.map(async (device) => {
    const actions: readonly string[] = device.access?.driver?.actions ?? []
    const connection = device.access?.connection
    const mock = connection && known(connection) && connection.kind === "mock" && !device.access?.driver
    if (!actions.includes("stop") && !mock)
      return { device: device.name, error: "NO STOP PATH — driver declares no stop action" }
    const signal = AbortSignal.timeout(Math.ceil((device.access?.driver?.timeout_s ?? 60) * 1000))
    return dispatchDevice(cwd, device, "stop", {}, undefined, signal).then(
      (reading) => ({ device: device.name, reading }),
      (error: unknown) => ({ device: device.name, error: `STOP FAILED — ${error instanceof Error ? error.message : String(error)}` }),
    )
  }))
}

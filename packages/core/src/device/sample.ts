import type { Device } from "./profile/schema.ts"
import { dispatchDevice } from "./dispatch.ts"

// Typed consumers select an observation without constraining device operations.
export function sampleDevice(cwd: string, device: Device, args: Record<string, unknown> = {}, origin?: string, signal?: AbortSignal) {
  return dispatchDevice(cwd, device, "$sample", args, origin, signal)
}

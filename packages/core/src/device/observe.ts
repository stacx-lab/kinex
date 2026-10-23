import { scoped } from "../scope.ts"
import type { Device } from "./profile/schema.ts"
import type { DeviceReading } from "./reading.ts"

// Observation of device traffic: every dispatchDevice settle (success or
// failure) is reported to the listeners, plus the synthetic "deactivate" event
// emitted BEFORE a device is unloaded. The recorder subscribes here to capture
// the observation/action stream without the dispatch path knowing about it.
// Same shape as Bus.subscribe; listeners must be cheap and never throw.

export interface DeviceEvent {
  workspace: string
  device: Device
  action: string
  args: Record<string, unknown>
  // Who dispatched: "snap" for the recorder's own reads; undefined for the
  // agent, tools and lifecycle helpers.
  origin?: string
  reading?: DeviceReading
  error?: string
  // Wall-clock ms at dispatch start and the round-trip duration.
  wall: number
  latencyMs: number
}

const listeners = scoped(() => new Set<(event: DeviceEvent) => void | Promise<void>>())

export function observeDevices(listener: (event: DeviceEvent) => void | Promise<void>): () => void {
  const owned = listeners()
  owned.add(listener)
  return () => {
    owned.delete(listener)
  }
}

export function notifyDevice(event: DeviceEvent): void {
  for (const listener of [...listeners()]) listener(event)
}

// Unlike ordinary observations, unload waits for record_stop before releasing hardware.
export async function notifyDeactivation(event: DeviceEvent): Promise<void> {
  const results = await Promise.allSettled([...listeners()].map(async listener => listener(event)))
  const errors: unknown[] = results.flatMap(result => result.status === "rejected" ? [result.reason] : [])
  if (errors.length) throw new AggregateError(errors, errors.map(String).join("; "))
}

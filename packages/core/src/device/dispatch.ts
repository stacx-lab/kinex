import { rosDispatch, rosReady } from "./ros.ts"
import { ProfileStore } from "./profile/store.ts"
import type { Device } from "./profile/schema.ts"
import type { DeviceReading } from "./reading.ts"
import { notifyDevice, notifyDeactivation } from "./observe.ts"
import { NamedError } from "../util/error.ts"
import { lifecycle } from "./profile/common.ts"

/** The rules for a requested device call. Stop is allowed on unloaded devices. */
export function checkDeviceCall(device: Device, action: string, args: Record<string, unknown>) {
  if (lifecycle.includes(action)) {
    if (Object.keys(args).length) throw new NamedError("DeviceLifecycleError", `${action} accepts no arguments`)
    return
  }
  if (action === "stop") return
  if (!device.loaded) throw new NamedError("DeviceInactiveError", `${device.name} is unloaded`)
  if (!device.operations[action])
    throw new NamedError("DeviceOperationError", `unknown operation ${device.name}.${action}; available: ${Object.keys(device.operations).join(", ")}`)
}

export async function dispatchDevice(cwd: string, device: Device, action: string, args: Record<string, unknown>, origin?: string, signal?: AbortSignal): Promise<DeviceReading> {
  signal?.throwIfAborted()
  if (!device.runtime) throw new NamedError("UnsupportedDeviceContract", `${device.name}: configure runtime.nodes and operations`)
  const workspace = await ProfileStore.workspaceDir(cwd)
  const wall = Date.now()
  try {
    const reading = await rosDispatch(workspace, device, action, args, signal)
    notifyDevice({ workspace, device, action, args, origin, reading, wall, latencyMs: Date.now() - wall })
    return reading
  } catch (error) {
    notifyDevice({ workspace, device, action, args, origin, error: String(error), wall, latencyMs: Date.now() - wall })
    throw error
  }
}

export interface ProbeResult { reading: DeviceReading; elapsedMs: number; serving?: boolean }

export async function probeDevice(cwd: string, device: Device): Promise<ProbeResult> {
  const started = Date.now()
  const reading = await dispatchDevice(cwd, device, "status", {})
  return { reading, elapsedMs: Date.now() - started, serving: await rosReady(cwd, device) }
}

export async function queueActivation(cwd: string, device: Device, signal?: AbortSignal) {
  const ready = dispatchDevice(cwd, device, "load", {}, undefined, signal)
  void ready.catch(() => {})
  return { ready }
}

export async function deactivateDevice(cwd: string, device: Device): Promise<void> {
  const workspace = await ProfileStore.workspaceDir(cwd)
  const errors: unknown[] = []
  await notifyDeactivation({ workspace, device, action: "deactivate", args: {}, wall: Date.now(), latencyMs: 0 })
    .catch((error: unknown) => errors.push(error))
  await dispatchDevice(workspace, device, "unload", {}).catch((error: unknown) => errors.push(error))
  if (errors.length) throw new NamedError("DeviceUnloadError", `unload failed for ${device.name}: ${errors.map(String).join("; ")}`, { errors: errors.map(String) })
}

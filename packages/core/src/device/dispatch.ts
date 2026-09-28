import { worldCommand, worldResult } from "./world.ts"
import { claimMotion, ownsMotion, ownedMotions } from "./ownership.ts"
import { isCommandAction } from "./interface.ts"
import { scheduleDevice, type CommandAdmission } from "./scheduler.ts"
import { scoped } from "../scope.ts"
import { jointReading, jointResult } from "./joint.ts"
import { spatialReading } from "./spatial.ts"
import { velocityReading } from "./velocity.ts"
import { writeCommand } from "./command.ts"
import { abortable } from "../util/abort.ts"
import { imuReading } from "./imu.ts"
import { modelOperation, modelInput, modelOutput } from "./model.ts"
import { forceTorqueReading } from "./force-torque.ts"
import path from "node:path"
import { CalibrationStore } from "../calibration/store.ts"
import { known, isJoint, type Device } from "./profile/schema.ts"
import { runDriver, isServing, stopServing, interruptServing, type DeviceReading } from "./driver.ts"
import { mockAct } from "./virtual.ts"
import { notifyDevice, notifyDeactivation } from "./observe.ts"
import { NamedError } from "../util/error.ts"

// The one routing point for reaching a device: the agent-written driver, or
// the in-memory mock — used by the device tools, the python-tool runner, the
// recorder, and the lifecycle helpers below.
export function route(cwd: string, device: Device, action: string, args: Record<string, unknown>, signal?: AbortSignal, admission?: CommandAdmission): Promise<DeviceReading> {
  admission?.check()
  const access = device.access
  const kind = access && known(access.connection) ? access.connection.kind : undefined
  if (access?.driver) return runDriver(cwd, device, action, args, signal, admission)
  if (kind === "mock") return Promise.resolve(mockAct(cwd, device, action, args))
  if (action === "unload") return Promise.resolve({ deviceID: device.name, kind: device.type, data: { unloaded: true } })
  return Promise.reject(
    new Error(
      `device "${device.name}" has no way to reach it: no access.driver is recorded (and its access.connection.kind is not "mock"). Write devices/${device.name}/driver.py and record it under access.driver first.`,
    ),
  )
}

// Lifecycle admission is separate from write serialization and observation.
const inactive = scoped(() => new Set<string>())

export function validateReading(device: Device, reading: DeviceReading): DeviceReading {
  const spatial = spatialReading(device, reading)
  switch (device.type) {
    case "joint":
    case "dexterous_hand": return jointReading(device, spatial)
    case "velocity": return velocityReading(device, spatial)
    case "imu": return imuReading(device, spatial)
    case "force_torque": return forceTorqueReading(device, spatial)
    default: return spatial
  }
}

export async function dispatchDevice(
  cwd: string,
  device: Device,
  action: string,
  args: Record<string, unknown>,
  origin?: string,
  signal?: AbortSignal,
): Promise<DeviceReading> {
  const workspace = await CalibrationStore.workspaceDir(cwd)
  return dispatchInWorkspace(workspace, device, action, args, origin, signal)
}

// Synchronous reservation lets startup enqueue load before exposing device tools.
function dispatchInWorkspace(workspace: string, device: Device, action: string, args: Record<string, unknown>, origin?: string, signal?: AbortSignal): Promise<DeviceReading> {
  const key = path.join(workspace, "devices", device.name)
  signal?.throwIfAborted()
  // Preflight before replacement; the driver independently validates at its boundary.
  const operation = modelOperation(device, action)
  args = modelInput(operation, args)
  if (action === "write") args = writeCommand(device, args)
  if (device.type === "world") args = worldCommand(action, args)
  if (action === "stop" && origin && !ownsMotion(key, origin))
    return Promise.resolve({ deviceID: device.name, kind: device.type, data: { stopped: false, terminated_by: "replaced" } })
  if (isCommandAction(device, action) && !["load", "unload", "stop", "wait"].includes(action))
    claimMotion(key, origin)
  if (action === "load") inactive().add(key)
  const wall = Date.now()
  const run = async (admission: CommandAdmission) => {
    signal?.throwIfAborted()
    if (["load", "unload", "status"].includes(action) && Object.keys(args).length)
      throw new NamedError("DeviceLifecycleError", `${action} accepts no arguments`)
    if (!["load", "unload", "status", "stop", "record_stop"].includes(action) && (!device.loaded || inactive().has(key)))
      throw new NamedError("DeviceInactiveError", `device "${device.name}" is inactive; load it before ${action}`)
    const interruptions = action === "stop" ? Promise.allSettled(
      affected.filter(name => name !== key).map(name => interruptServing(workspace, path.basename(name))),
    ) : Promise.resolve([])
    const reading = await route(workspace, device, action, args, signal, admission).finally(async () => {
      if (action === "unload") await stopServing(workspace, device.name)
    })
    const failures = (await interruptions).filter(result => result.status === "rejected")
    if (failures.length) throw new NamedError("DeviceStopError", "stop applied but an affected driver could not acknowledge interruption")
    if (action === "load") inactive().delete(key)
    if (isJoint(device) && action === "write") {
      try {
        return jointResult(device, reading)
      } catch (error) {
        await route(workspace, device, "stop", {})
        throw error
      }
    }
    if (device.type === "world" && ["read", "wait"].includes(action)) return worldResult(action, reading)
    return action === "read" ? validateReading(device, reading) : modelOutput(operation, reading)
  }
  const stop = "stop" in device.intrinsics ? device.intrinsics.stop : undefined
  const affected = stop && known(stop) ? stop.affected_devices.map(name => path.join(workspace, "devices", name)) : [key]
  const settle = scheduleDevice(key, action, run, affected)
  return abortable(settle, signal)
    .then(
      (reading) => {
        notifyDevice({ workspace, device, action, args: args, origin, reading, wall, latencyMs: Date.now() - wall })
        return reading
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        notifyDevice({ workspace, device, action, args: args, origin, error: message, wall, latencyMs: Date.now() - wall })
        throw error
      },
    )
}

// Lifecycle requests fence resource users; shutdown completes before reload.
// Recorder deactivation stays outside the fence because it dispatches record_stop.
export interface ProbeResult {
  reading: DeviceReading
  elapsedMs: number
  serving?: boolean
}

export async function probeDevice(cwd: string, device: Device): Promise<ProbeResult> {
  const started = Date.now()
  const reading = await dispatchDevice(cwd, device, "status", {})
  return {
    reading,
    elapsedMs: Date.now() - started,
    ...(device.access?.driver?.persistent ? { serving: await isServing(cwd, device.name) } : {}),
  }
}

export async function queueActivation(cwd: string, device: Device, signal?: AbortSignal) {
  const workspace = await CalibrationStore.workspaceDir(cwd)
  signal?.throwIfAborted()
  const ready = dispatchInWorkspace(workspace, device, "load", {}, undefined, signal)
  void ready.catch(() => {})
  return { ready, activating: device.access?.driver !== undefined }
}

export async function deactivateDevice(cwd: string, device: Device): Promise<void> {
  const workspace = await CalibrationStore.workspaceDir(cwd)
  inactive().add(path.join(workspace, "devices", device.name))
  const errors: unknown[] = []
  if (device.access?.driver?.actions.includes("stop") || "stop" in device.intrinsics)
    await dispatchInWorkspace(workspace, device, "stop", {}).catch((error: unknown) => errors.push(error))
  await notifyDeactivation({ workspace, device, action: "deactivate", args: {}, wall: Date.now(), latencyMs: 0 })
    .catch((error: unknown) => errors.push(error))
  await dispatchInWorkspace(workspace, device, "unload", {})
    .catch((error: unknown) => errors.push(error))
  if (errors.length) throw new NamedError("DeviceUnloadError", `unload failed for ${device.name}: ${errors.map(String).join("; ")}`, { errors: errors.map(String) })
}

export async function stopOwnedMotions(cwd: string, owner: string): Promise<void> {
  const workspace = await CalibrationStore.workspaceDir(cwd)
  const results = await Promise.allSettled(ownedMotions(owner).filter(key => path.dirname(key) === path.join(workspace, "devices")).map(async key => {
    const device = await CalibrationStore.readDevice(cwd, path.basename(key))
    if (device?.loaded) await dispatchDevice(cwd, device, "stop", {}, owner)
  }))
  const failures = results.filter(result => result.status === "rejected")
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), "owned motion stop failed")
}

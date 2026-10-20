import { lifecycle, streamActions } from "./profile/common.ts"
import { isModel, isActuated, type Device } from "./profile/schema.ts"

// Required driver actions gate access readiness. Hardware and
// simulators use this same contract; only the in-memory mock bypasses drivers.
// Setup and wire examples live in core device guides.

export { lifecycle as LIFECYCLE_ACTIONS } from "./profile/common.ts"

export function requiredActions(device: Device): string[] {
  if (device.runtime) return ["load", "unload", "status", "stop", ...Object.keys(device.operations)]
  if (device.type === "world") return ["read", "wait", ...lifecycle]
  const base = ["read", ...lifecycle]
  if (device.type === "joint" || device.type === "dexterous_hand") {
    const k = device.intrinsics.kinematics
    return [...base, "write", "stop", ...(k?.fk || (device.type === "dexterous_hand" && device.intrinsics.geometry?.fingers) ? ["fk"] : []), ...(k?.ik ? ["ik"] : [])]
  }
  if (isActuated(device)) return [...base, "write", "stop"]
  if (isModel(device)) return [...base, ...device.intrinsics.operations.map((operation) => operation.name)]
  return base
}

// The verbs a declared driver is still missing — empty means conformant.
export function missingActions(device: Device, declared: readonly string[]): string[] {
  return requiredActions(device).filter((action) => !declared.includes(action))
}

// Read-classified actions: pure observation/computation, never motion.
const READ_ACTIONS = new Set(["read", "status", "ik", "fk", ...streamActions])

// Whether dispatching `action` on this device counts as COMMANDING it — the
// permission boundary of the `device` tool and the perception-tool restriction.
// On an actuated device every verb outside the read set is a command (write,
// stop, any custom verb); a non-actuated device cannot be commanded at all.
export function isCommandAction(device: Device, action: string): boolean {
  if (device.runtime) return action === "stop" || device.operations[action]?.direction === "input"
  if (device.type === "world") return action === "wait"
  if (!isActuated(device)) return false
  return !READ_ACTIONS.has(action)
}

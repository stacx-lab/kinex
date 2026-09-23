import { lifecycle, streamActions } from "./profile/common.ts"
import { isModel, isActuated, known, type Device } from "./profile/schema.ts"

// Required driver actions gate access readiness in calib_plan. Hardware and
// simulators use this same contract; only the in-memory mock bypasses drivers.
// Setup and wire examples live in assets/builtin/skill/setup-device/SKILL.md.

export { lifecycle as LIFECYCLE_ACTIONS } from "./profile/common.ts"

export function requiredActions(device: Device): string[] {
  if (device.type === "world") return []
  const base = ["read", ...lifecycle]
  if (device.type === "joint" || device.type === "dexterous_hand") {
    const k = device.intrinsics.kinematics
    return [...base, "write", "stop", ...(k?.fk ? ["fk"] : []), ...(k?.ik ? ["ik"] : [])]
  }
  if (isActuated(device)) return [...base, "write", "stop"]
  if (isModel(device)) return [...base, ...device.intrinsics.operations.map((operation) => operation.name)]
  return base
}

// The verbs a declared driver is still missing — empty means conformant.
export function missingActions(device: Device, declared: readonly string[]): string[] {
  return requiredActions(device).filter((action) => !declared.includes(action))
}

// OPTIONAL native capture: the driver runs a capture thread between these two
// verbs and writes the stream's video/state files itself (dense, no per-frame
// traffic). Needs a persistent driver — the thread must outlive one call.
// Without it the recorder still streams the device: the harness reads it at
// the requested rate and encodes the same products (slower — one read round
// trip per frame).
export { streamActions as STREAM_ACTIONS } from "./profile/common.ts"

// Why the driver cannot capture natively (the harness reads instead), or
// undefined when it can.
export function streamRefusal(device: Device): string | undefined {
  const driver = device.access?.driver
  if (!driver) return "no driver for native capture; core will sample through device dispatch"
  if (!driver.persistent) return "driver is not persistent — set access.driver.persistent: true so the capture thread outlives a call"
  const actions: readonly string[] = driver.actions
  const missing = streamActions.filter((action) => !actions.includes(action))
  if (missing.length > 0) return `driver lacks ${missing.join("/")} (wire kinex.stream into the driver, see setup-device)`
  return undefined
}

// Read-classified actions: pure observation/computation, never motion.
const READ_ACTIONS = new Set(["read", "status", "ik", "fk", ...streamActions])

// Whether dispatching `action` on this device counts as COMMANDING it — the
// permission boundary of the `device` tool and the perception-tool restriction.
// On an actuated device every verb outside the read set is a command (write,
// stop, any custom verb); a non-actuated device cannot be commanded at all.
export function isCommandAction(device: Device, action: string): boolean {
  if (!isActuated(device)) return false
  return !READ_ACTIONS.has(action)
}

import { z } from "zod"
import { deviceActions, deviceJoints, deviceHome, isActuated, isJoint, known, type Device } from "./profile/schema.ts"
import { segmentFields } from "./profile/common.ts"
import { velocityCommand } from "./velocity.ts"
import { leggedCommand } from "./legged.ts"
import { NamedError } from "../util/error.ts"

const HOME_RECOVERY_TOLERANCE = Math.PI / 180

// Shared preflight for all writes. Drivers also validate before effects.
export function writeCommand(device: Device, args: Record<string, unknown>): Record<string, unknown> {
  if (!isActuated(device)) throw new NamedError("DeviceCommandError", `${device.name} is not actuated`)
  if (device.type === "legged_base") return leggedCommand(device, args)
  if (isJoint(device)) return jointCommand(device, args)
  if (device.type === "velocity") return velocityCommand(device, args)
  const [dimension] = deviceActions(device)
  if (!dimension) throw new NamedError("DeviceCommandError", `${device.name} has no resolved action space`)
  const command = z.strictObject({ actions: z.array(z.number()).min(1), speedFraction: z.number().positive().max(1).optional(), ...segmentFields }).parse(args)
  for (const value of command.actions) {
    if (dimension.bounds && (value < dimension.bounds.min || value > dimension.bounds.max))
      throw new NamedError("DeviceCommandError", `${device.name}: target exceeds bounds`)
  }
  const control = "control" in device.intrinsics ? device.intrinsics.control : undefined
  if (control && known(control)) {
    if (control.mode === "binary" && command.actions.some(value => ![control.on_target, control.off_target].includes(value)))
      throw new NamedError("DeviceCommandError", "binary target must equal on/off target")
    if (control.mode === "direction") command.actions = command.actions.map(Math.sign)
  }
  if (command.speedFraction !== undefined) {
    const speed = control && known(control) && "speed" in control ? control.speed : null
    if (!speed || !known(speed)) throw new NamedError("DeviceCommandError", `${device.name}: speed is unsupported or unresolved`)
  }
  return command
}

function jointCommand(device: Device, args: Record<string, unknown>): Record<string, unknown> {
  if (!isJoint(device) || !known(device.intrinsics.control))
    throw new NamedError("DeviceCommandError", "joint control is unresolved")
  const dimensions = deviceActions(device)
  if (!dimensions.length) throw new NamedError("DeviceCommandError", "joint model is unresolved")
  const command = z.strictObject({ actions: z.array(z.array(z.number()).length(dimensions.length)).min(1), ...segmentFields }).parse(args)
  if (device.intrinsics.control.limit_handling === "native") return command
  const joints = deviceJoints(device)
  const home = deviceHome(device)
  const last = command.actions.at(-1)!
  const recovery = device.type === "joint" && home
    && last.every((q, i) => Math.abs(q - home[i]!) <= 1e-9)
  const tolerance = recovery ? HOME_RECOVERY_TOLERANCE : 0
  for (const [step, values] of command.actions.entries()) {
    for (const [i, value] of values.entries()) {
      const bounds = dimensions[i]!.bounds
      if (!bounds) continue
      const margin = step < command.actions.length - 1 && joints[i]!.type === "revolute" ? tolerance : 0
      if (value < bounds.min - margin || value > bounds.max + margin)
        throw new NamedError("DeviceCommandError", "target exceeds joint limits")
      const previous = command.actions[step - 1]?.[i]
      if (previous !== undefined && ((value < bounds.min && value < previous) || (value > bounds.max && value > previous)))
        throw new NamedError("DeviceCommandError", "joint limits recovery must move inward")
    }
  }
  return command
}

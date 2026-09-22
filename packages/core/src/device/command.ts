import { z } from "zod"
import { deviceActions, isActuated, known, type Device } from "./profile/schema.ts"
import { segmentFields } from "./profile/common.ts"
import { velocityCommand } from "./velocity.ts"
import { NamedError } from "../util/error.ts"

// Shared preflight for all writes. Drivers also validate before effects.
export function writeCommand(device: Device, args: Record<string, unknown>): Record<string, unknown> {
  if (!isActuated(device)) throw new NamedError("DeviceCommandError", `${device.name} is not actuated`)
  if (device.type === "velocity") return velocityCommand(device, args)
  const dimensions = deviceActions(device)
  if (!dimensions.length) throw new NamedError("DeviceCommandError", `${device.name} has no resolved action space`)
  const command = z.strictObject({ target: z.array(z.number()).length(dimensions.length), speedFraction: z.number().positive().max(1).optional(), ...segmentFields }).parse(args)
  for (const [index, dimension] of dimensions.entries()) {
    const value = command.target[index]!
    if (dimension.bounds && (value < dimension.bounds.min || value > dimension.bounds.max))
      throw new NamedError("DeviceCommandError", `${device.name}: target ${index} exceeds bounds`)
  }
  const control = "control" in device.intrinsics ? device.intrinsics.control : undefined
  if (control && known(control)) {
    if (control.mode === "binary" && ![control.on_target, control.off_target].includes(command.target[0]!))
      throw new NamedError("DeviceCommandError", "binary target must equal on/off target")
    if (control.mode === "direction") command.target[0] = Math.sign(command.target[0]!)
  }
  if (command.speedFraction !== undefined) {
    const speed = control && known(control) && "speed" in control ? control.speed : null
    if (!speed || !known(speed)) throw new NamedError("DeviceCommandError", `${device.name}: speed is unsupported or unresolved`)
  }
  return command
}

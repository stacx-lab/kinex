import { z } from "zod"
import { deviceActions, isActuated, isJoint, known, type Device } from "./profile/schema.ts"
import { segmentFields } from "./profile/common.ts"
import { velocityCommand } from "./velocity.ts"
import { NamedError } from "../util/error.ts"

// Shared preflight for all writes. Drivers also validate before effects.
export function writeCommand(device: Device, args: Record<string, unknown>): Record<string, unknown> {
  if (!isActuated(device)) throw new NamedError("DeviceCommandError", `${device.name} is not actuated`)
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
  const target = z.array(z.number()).length(dimensions.length).superRefine((values, ctx) => {
    for (const [i, value] of values.entries()) {
      const bounds = dimensions[i]!.bounds
      if (device.intrinsics.control !== "???" && device.intrinsics.control.limit_handling !== "native" && bounds && (value < bounds.min || value > bounds.max))
        ctx.addIssue({ code: "custom", path: [i], message: "target exceeds joint limits" })
    }
  })
  return z.strictObject({ actions: z.array(target).min(1), ...segmentFields }).parse(args)
}

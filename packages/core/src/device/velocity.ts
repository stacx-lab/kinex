import { z } from "zod"
import { hasMissing, segmentFields } from "./profile/common.ts"
import { isVelocity, known, type Device } from "./profile/schema.ts"
import type { DeviceReading } from "./driver.ts"
import { NamedError } from "../util/error.ts"

const values = z.record(z.string(), z.number())
export function velocityCommand(device: Extract<Device, { type: "velocity" }>, args: Record<string, unknown>): Record<string, unknown> {
  const { control } = device.intrinsics
  if (!known(control) || hasMissing(control)) throw new NamedError("VelocityCommandError", "velocity control is unresolved")
  const selected = typeof args.mode === "string" && Object.hasOwn(control.modes, args.mode) ? control.modes[args.mode] : undefined
  for (const channel of ["velocity", "posture"] as const) {
    const capability = selected?.[channel]
    if (capability && Array.isArray(args[channel])) {
      const example = Object.fromEntries(capability.components.map(({ axis }) => [axis, 0]))
      throw new NamedError("VelocityCommandError", `${channel} requires named axes, for example ${JSON.stringify(example)}; arrays are unsupported`)
    }
  }
  const command = z.strictObject({ mode: z.string(), velocity: values.optional(), posture: values.optional(), ...segmentFields }).parse(args)
  const mode = Object.hasOwn(control.modes, command.mode) ? control.modes[command.mode] : undefined
  if (!mode) throw new NamedError("VelocityCommandError", `unsupported controller mode: ${command.mode}`)
  for (const channel of ["velocity", "posture"] as const) {
    const capabilities = mode[channel]
    const target: Record<string, number> | undefined = command[channel]
    if (capabilities === null) {
      if (target !== undefined)
        throw new NamedError("VelocityCommandError", `${channel} is unsupported in this mode`)
      continue
    }
    if (!target || (Object.keys(target).length !== capabilities.components.length))
      throw new NamedError("VelocityCommandError", `${channel} requires its declared axes`)
    for (const component of capabilities.components) {
      const value = target[component.axis]
      const bounds = component.bounds
      if (value === undefined || !known(bounds) || (control.limit_handling !== "native" && bounds !== null && (value < bounds.min || value > bounds.max)))
        throw new NamedError("VelocityCommandError", `${channel}.${component.axis} is missing or outside bounds`)
    }
  }
  return command
}

export function velocityReading(device: Device, reading: DeviceReading): DeviceReading {
  if (!isVelocity(device)) return reading
  const { feedback } = device.intrinsics
  if (!known(feedback) || hasMissing(feedback) || !known(feedback.velocity_components))
    throw new NamedError("VelocityReadingError", "velocity feedback is unresolved")
  const data = z.object({
    pose: z.never().optional(),
    height_m: z.number().optional(),
    velocities: z.array(z.number()).length(feedback.velocity_components.length),
    faults: z.array(z.strictObject({ code: z.string() })),
    timestamp: z.number(),
  }).passthrough().parse(reading.data)
  if (data.frame_poses && typeof data.frame_poses === "object" && !Array.isArray(data.frame_poses) && Object.keys(data.frame_poses).length === 0)
    delete data.frame_poses
  return { ...reading, data }
}

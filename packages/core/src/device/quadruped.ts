import { z } from "zod"
import { known, type Device } from "./profile/schema.ts"
import { modelValueSchema } from "./profile/model.ts"
import type { DeviceReading } from "./driver.ts"
import { NamedError } from "../util/error.ts"

type Quadruped = Extract<Device, { type: "quadruped_base" }>

export function quadrupedCommand(device: Quadruped, args: Record<string, unknown>): Record<string, unknown> {
  const { control } = device.intrinsics
  if (!known(control)) throw new NamedError("QuadrupedCommandError", "quadruped control is unresolved")
  const command = z.record(z.string(), z.unknown()).parse(modelValueSchema(control.write).parse(args))
  if (Object.hasOwn(command, "mode")) {
    const target = z.string().min(1).parse(command.mode)
    if (!control.device_modes || !Object.hasOwn(control.device_modes, target))
      throw new NamedError("QuadrupedCommandError", `unsupported device mode: ${target}`)
  }
  return command
}

export function quadrupedReading(device: Quadruped, reading: DeviceReading): DeviceReading {
  const data = z.object({ timestamp: z.number(), faults: z.array(z.strictObject({ code: z.string() })) }).passthrough().parse(reading.data)
  const { control } = device.intrinsics
  if (known(control) && control.device_modes) z.string().min(1).nullable().parse(data.mode)
  return { ...reading, data }
}

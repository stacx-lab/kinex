import { z } from "zod"
import { known, type Device } from "./profile/schema.ts"
import { modelValueSchema } from "./profile/model.ts"
import type { DeviceReading } from "./driver.ts"
import { NamedError } from "../util/error.ts"

type Legged = Extract<Device, { type: "legged_base" }>

export function leggedCommand(device: Legged, args: Record<string, unknown>): Record<string, unknown> {
  const { control } = device.intrinsics
  if (!known(control)) throw new NamedError("LeggedCommandError", "legged control is unresolved")
  const command = z.record(z.string(), z.unknown()).parse(modelValueSchema(control.write).parse(args))
  if (Object.hasOwn(command, "mode")) {
    const target = z.string().min(1).parse(command.mode)
    if (!control.device_modes || !Object.hasOwn(control.device_modes, target))
      throw new NamedError("LeggedCommandError", `unsupported device mode: ${target}`)
  }
  return command
}

export function leggedReading(device: Legged, reading: DeviceReading): DeviceReading {
  const data = z.object({ timestamp: z.number(), faults: z.array(z.strictObject({ code: z.string() })) }).passthrough().parse(reading.data)
  const { control } = device.intrinsics
  if (known(control) && control.device_modes) z.string().min(1).nullable().parse(data.mode)
  return { ...reading, data }
}

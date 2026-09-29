import { z } from "zod"
import type { DeviceReading } from "./driver.ts"

export function worldCommand(action: string, args: Record<string, unknown>): Record<string, unknown> {
  return action === "wait"
    ? z.strictObject({ duration_s: z.number().nonnegative() }).parse(args)
    : z.strictObject({}).parse(args)
}

// A world may report its episode's budget with its clock (RoboEnv does): an agent paces itself with it.
const budget = z.strictObject({ used: z.number().nonnegative(), max: z.number().positive().nullable(), unit: z.string().min(1) })

export function worldResult(action: string, reading: DeviceReading): DeviceReading {
  const shape = { time_s: z.number().nonnegative(), budget: budget.optional() }
  const data = (action === "wait"
    ? z.object({ ...shape, elapsed_s: z.number().nonnegative() })
    : z.object(shape)).parse(reading.data)
  return { ...reading, data }
}

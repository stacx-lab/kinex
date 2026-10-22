import { field } from "./common.ts"
import { z } from "zod"
import { SensorChannel as ForceTorqueChannel } from "./sensor.ts"
export { SensorChannel as ForceTorqueChannel } from "./sensor.ts"

export const ForceTorqueMeasurement = z.strictObject({
  quantity: field(z.enum(["transmitted", "external", "contact_normal", "contact_total", "actuation"])),
  target: field(z.strictObject({ device: field(z.string().min(1)), frame: field(z.string().min(1)) })),
  force: field(ForceTorqueChannel.nullable()),
  torque: field(ForceTorqueChannel.nullable()),
}).refine((v) => v.force !== null || v.torque !== null, "at least one force or torque measurement is required")
export const forceTorqueShape = {
  measurement: field(ForceTorqueMeasurement),
  sample_rate_hz: z.number().positive().nullable().default(null),
}

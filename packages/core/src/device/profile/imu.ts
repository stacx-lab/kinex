import { field } from "./common.ts"
import { z } from "zod"
import { SensorChannel } from "./sensor.ts"

export const ImuOrientation = z.strictObject({
  reference: field(z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("frame"), frame: field(z.string().min(1)) }),
    z.strictObject({ kind: z.literal("startup") }),
    z.strictObject({ kind: z.literal("gravity_aligned"), heading: field(z.enum(["relative", "magnetic_north", "true_north"])) }),
  ])),
})
export const ImuAcceleration = SensorChannel.safeExtend({
  quantity: field(z.enum(["specific_force", "gravity_removed"])),
})
export const ImuMeasurement = z.strictObject({
  angular_velocity: field(SensorChannel.nullable()),
  linear_acceleration: field(ImuAcceleration.nullable()),
  orientation: field(ImuOrientation.nullable()),
  magnetic_field: field(SensorChannel.nullable()),
}).refine((v) => v.angular_velocity !== null || v.linear_acceleration !== null || v.orientation !== null,
  "at least one inertial measurement is required")
export const imuShape = {
  measurement: field(ImuMeasurement),
  sample_rate_hz: field(z.number().positive().nullable()),
}

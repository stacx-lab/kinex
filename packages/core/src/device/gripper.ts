import { z } from "zod"
import { known, type Device } from "./profile/schema.ts"
import type { DeviceReading } from "./driver.ts"
import { NamedError } from "../util/error.ts"

export function gripperReading(device: Device, reading: DeviceReading): DeviceReading {
  if (device.type !== "gripper") return reading
  const { feedback } = device.intrinsics
  if (!known(feedback)) throw new NamedError("GripperReadingError", "gripper feedback is unresolved")
  const data = z.object({
    aperture_m: feedback.aperture_m ? z.number().nonnegative() : z.null(),
    faults: z.array(z.strictObject({ code: z.string() })),
    timestamp: z.number(),
    positions: z.never().optional(), velocities: z.never().optional(),
    frame_poses: z.never().optional(), force_n: z.never().optional(),
    pressure_pa: z.never().optional(), object_detected: z.never().optional(),
  }).passthrough().parse(reading.data)
  return { ...reading, data }
}

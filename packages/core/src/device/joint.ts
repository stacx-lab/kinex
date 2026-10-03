import { z } from "zod"
import { isJoint, deviceJoints, known, type Device } from "./profile/schema.ts"
import type { DeviceReading } from "./driver.ts"
import { NamedError } from "../util/error.ts"

export function jointReading(device: Device, reading: DeviceReading): DeviceReading {
  if (!isJoint(device)) return reading
  const feedback = device.intrinsics.feedback
  const size = deviceJoints(device).length
  if (!known(feedback) || !size) throw new NamedError("JointReadingError", "joint model or feedback is unresolved")
  const data = z.object({
    positions: z.array(z.number()).length(size),
    velocities: feedback.velocities ? z.array(z.number()).length(size) : z.array(z.number()).length(0).default([]),
    efforts: feedback.efforts ? z.array(z.number()).length(size) : z.array(z.number()).length(0).default([]),
    faults: z.array(z.strictObject({ code: z.string() })),
    timestamp: z.number(),
    frame_poses: z.never().optional(),
  }).passthrough().parse(reading.data)
  return { ...reading, data }
}

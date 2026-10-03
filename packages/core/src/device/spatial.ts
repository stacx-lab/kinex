import { z } from "zod"
import { Pose } from "./profile/common.ts"
import type { Device } from "./profile/schema.ts"
import type { DeviceReading } from "./driver.ts"

export function spatialReading(device: Device, reading: DeviceReading): DeviceReading {
  if (!("frames" in device.intrinsics) || ["joint", "dexterous_hand", "gripper"].includes(device.type) || reading.data?.frame_poses === undefined) return reading
  const definitions = device.intrinsics.frames
  const frame_poses = z.record(z.string(), Pose).refine(
    (frames) => Object.keys(frames).every((name) => Object.hasOwn(definitions, name)
      && (definitions[name]!.translation_m === null || definitions[name]!.rotation_xyzw === null)),
    "frame_poses must name declared frames with unknown transforms",
  ).parse(reading.data?.frame_poses)
  return { ...reading, data: { ...reading.data, frame_poses } }
}

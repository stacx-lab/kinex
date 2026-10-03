import type { Device } from "./schema.ts"
import type { LocalFrame } from "./common.ts"

export function modelFrames(device: Device): string[] {
  if (device.type !== "joint" && device.type !== "dexterous_hand") return []
  const facts = device.intrinsics
  const geometry = "geometry" in facts ? facts.geometry : undefined
  return [
    ...(facts.kinematics ? [facts.kinematics.frame] : []),
    ...(geometry ? [...Object.values(geometry.fingers).map(finger => finger.tip_frame), geometry.center.frame] : []),
  ]
}

export function deviceFrames(device: Device): Record<string, LocalFrame | { parent_frame: null }> {
  return {
    ...("frames" in device.intrinsics ? device.intrinsics.frames : {}),
    ...Object.fromEntries(modelFrames(device).map(name => [name, { parent_frame: null }])),
  }
}

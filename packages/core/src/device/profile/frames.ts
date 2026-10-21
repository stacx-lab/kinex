import type { Device } from "./schema.ts"
import type { LocalFrame } from "./common.ts"

export function modelFrames(device: Device): string[] {
  if (device.type !== "joint" && device.type !== "dexterous_hand") return []
  const facts = device
  const geometry = "geometry" in facts ? facts.geometry : undefined
  return [
    ...(facts.kinematics ? [facts.kinematics.frame] : []),
    ...Object.values(geometry?.fingers ?? {}).map(finger => finger.tip_frame),
    ...(geometry?.center ? [geometry.center.frame] : []),
  ]
}

export function deviceFrames(device: Device): Record<string, LocalFrame> {
  return "frames" in device ? device.frames : {}
}

// Validate topology, including unknown edges: calibration must not create a cycle.
export function frameErrors(devices: Device[], external = true): string[] {
  const frames = new Map<string, LocalFrame>(devices.flatMap(device => Object.entries(deviceFrames(device)).map(([name, frame]) => [`${device.name}:${name}`, frame] as const)))
  const errors = new Set<string>()
  for (const [name, frame] of frames) {
    if (frame.parent !== null && !frames.has(frame.parent) && (external || frame.parent.split(":")[0] === name.split(":")[0]))
      errors.add(`${name}: unknown parent frame ${frame.parent}`)
    const seen = new Set<string>([name])
    let parent = frame.parent
    while (parent !== null && frames.has(parent)) {
      if (seen.has(parent)) { errors.add(`${name}: frame parents must be acyclic`); break }
      seen.add(parent)
      parent = frames.get(parent)!.parent
    }
  }
  return [...errors]
}

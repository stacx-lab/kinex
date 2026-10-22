import type { Device } from "./schema.ts"
import type { LocalFrame } from "./common.ts"
import { deviceTree, urdfSpec } from "./urdf.ts"

export function deviceFrames(device: Device): Record<string, LocalFrame> {
  return "frames" in device ? device.frames : {}
}

// URDF links below the base link are frames under the device base; undefined until resolved.
function links(device: Device): string[] | undefined {
  if (!urdfSpec(device)) return []
  const tree = deviceTree(device)
  return tree?.links.filter(link => link !== tree.base_link)
}

// Validate topology, including unknown edges: calibration must not create a cycle.
// Parents on a device whose URDF is unresolved stay unchecked until it resolves.
export function frameErrors(devices: Device[], external = true): string[] {
  const parents = new Map<string, string | null>()
  const unresolved = new Set<string>()
  const errors = new Set<string>()
  for (const device of devices) {
    for (const [name, frame] of Object.entries(deviceFrames(device))) parents.set(`${device.name}:${name}`, frame.parent)
    const names = links(device)
    if (!names) unresolved.add(device.name)
    for (const name of (names ?? []).map(link => `${device.name}:${link}`)) {
      if (parents.has(name)) errors.add(`${name}: URDF link collides with a profile frame`)
      else parents.set(name, `${device.name}:base`)
    }
  }
  for (const [name, start] of parents) {
    const owner = start?.split(":")[0]
    if (start && !parents.has(start) && !unresolved.has(owner!) && (external || owner === name.split(":")[0]))
      errors.add(`${name}: unknown parent frame ${start}`)
    const seen = new Set<string>([name])
    let parent = start
    while (parent && parents.has(parent)) {
      if (seen.has(parent)) { errors.add(`${name}: frame parents must be acyclic`); break }
      seen.add(parent)
      parent = parents.get(parent)!
    }
  }
  return [...errors]
}

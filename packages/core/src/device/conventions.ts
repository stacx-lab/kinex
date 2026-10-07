import path from "node:path"
import { contentRoots } from "../config/content.ts"
import { Assets } from "../installation/assets.ts"
import { exists } from "../util/filesystem.ts"
import { readDeviceGuide } from "./guide.ts"
import { ProfileStore } from "./profile/store.ts"
import { NamedError } from "../util/error.ts"
import type { Device } from "./profile/schema.ts"

export const deviceContentRoots = (cwd: string) => contentRoots(cwd, "device", Assets.builtin("device"))

const customGuideTypes = new Set<string>(["legged_base"])

class CustomDeviceGuideError extends NamedError {
  constructor(file: string, type: string) {
    super("CustomDeviceGuideError", `${file}: custom DEVICE.md is not allowed for device type "${type}"; allowed types: ${[...customGuideTypes].join(", ")}. Use the shared type guide and move instance parameters into profile.yaml and SDK adaptation into the driver.`)
  }
}

// Allowed instance guides take precedence; shared type guides are included once and
// scoped to the loaded devices that actually use them.
export async function deviceConventions(cwd: string, devices: readonly Pick<Device, "name" | "type">[]): Promise<string> {
  const sections: string[] = []
  const roots = await deviceContentRoots(cwd)
  const guides = new Map<string, { type: string; names: string[] }>()
  for (const device of [...devices].sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name))) {
    const customGuide = path.join(await ProfileStore.deviceDir(cwd, device.name), "DEVICE.md")
    if (await exists(customGuide) && !customGuideTypes.has(device.type))
      throw new CustomDeviceGuideError(customGuide, device.type)
    const candidates = [
      customGuide,
      ...roots.map(root => path.join(root, "templates", device.type, "DEVICE.md")),
    ]
    for (const guidePath of candidates) {
      if (!(await exists(guidePath))) continue
      const group = guides.get(guidePath) ?? { type: device.type, names: [] }
      group.names.push(device.name)
      guides.set(guidePath, group)
      break
    }
  }
  for (const [guidePath, { type, names }] of guides) {
    const guide = await readDeviceGuide(guidePath)
    if (!guide.use) throw new Error(`${guidePath}: missing ## Use section`)
    sections.push(`<device_conventions type="${type}" devices="${names.join(", ")}">\n${guide.use}\n</device_conventions>`)
  }
  return sections.join("\n\n")
}

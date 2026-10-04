import path from "node:path"
import { contentRoots } from "../config/content.ts"
import { Assets } from "../installation/assets.ts"
import { exists } from "../util/filesystem.ts"
import { readDeviceGuide } from "./guide.ts"
import { ProfileStore } from "./profile/store.ts"
import type { Device } from "./profile/schema.ts"

export const deviceContentRoots = (cwd: string) => contentRoots(cwd, "device", Assets.builtin("device"))

// Instance guides take precedence; shared type guides are included once and
// scoped to the loaded devices that actually use them.
export async function deviceConventions(cwd: string, devices: readonly Pick<Device, "name" | "type">[]): Promise<string> {
  const sections: string[] = []
  const roots = await deviceContentRoots(cwd)
  const guides = new Map<string, { type: string; names: string[] }>()
  for (const device of [...devices].sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name))) {
    const candidates = [
      path.join(await ProfileStore.deviceDir(cwd, device.name), "DEVICE.md"),
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

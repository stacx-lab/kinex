import path from "node:path"
import { contentRoots } from "../config/content.ts"
import { Assets } from "../installation/assets.ts"
import { exists } from "../util/filesystem.ts"
import { readDeviceGuide } from "./guide.ts"

export const deviceContentRoots = (cwd: string) => contentRoots(cwd, "device", Assets.builtin("device"))

// Runtime contracts follow the same override roots as device templates. Include
// each loaded type once, regardless of the number of instances of that type.
export async function deviceConventions(cwd: string, types: readonly string[]): Promise<string> {
  const sections: string[] = []
  const roots = await deviceContentRoots(cwd)
  for (const type of [...new Set(types)].sort()) {
    for (const root of roots) {
      const guidePath = path.join(root, "templates", type, "DEVICE.md")
      if (!(await exists(guidePath))) continue
      const guide = await readDeviceGuide(guidePath)
      if (!guide.use) throw new Error(`${guidePath}: missing ## Use section`)
      sections.push(`<device_conventions type="${type}">\n${guide.use}\n</device_conventions>`)
      break
    }
  }
  return sections.join("\n\n")
}

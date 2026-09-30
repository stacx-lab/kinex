import { readFile } from "node:fs/promises"
import { glob } from "tinyglobby"
import path from "node:path"
import { contentRoots } from "@kinex/core/config/content"
import { Assets } from "./assets.ts"
import { parseFrontmatter } from "@kinex/core/skill/index"
import { exists } from "@kinex/core/util/filesystem"

// Concrete instances live in device/<name>; type templates in
// device/templates/<type>. Search all instance roots before type templates.

export interface DeviceTemplateInfo {
  kind: "instance" | "template"
  name: string
  type: string
  description: string
  directory: string
}

const builtinDir = () => Assets.builtin("device")
export const deviceContentRoots = (cwd: string) => contentRoots(cwd, "device", builtinDir())

export async function listDeviceTemplates(cwd: string): Promise<DeviceTemplateInfo[]> {
  const templates: DeviceTemplateInfo[] = []
  const seen = new Set<string>()
  const roots = await deviceContentRoots(cwd)
  for (const kind of ["instance", "template"] as const) {
    for (const contentRoot of roots) {
      const root = kind === "template" ? path.join(contentRoot, "templates") : contentRoot
      if (!(await exists(root))) continue
      const pattern = "*/DEVICE.md"
      for (const entry of await glob(pattern, { cwd: root, dot: true })) {
        const file = path.join(root, entry)
        const { meta } = parseFrontmatter(await readFile(file, "utf8"))
        const name = meta["name"] ?? path.basename(path.dirname(file))
        const key = `${kind}:${name}`
        if (seen.has(key)) continue
        seen.add(key)
        templates.push({
          kind,
          name,
          type: meta["type"] ?? "other",
          description: meta["description"] ?? "",
          directory: path.dirname(file),
        })
      }
    }
  }
  return templates
}

export async function resolveDeviceTemplate(cwd: string, name: string, type?: string): Promise<DeviceTemplateInfo | undefined> {
  const definitions = await listDeviceTemplates(cwd)
  return definitions.find((entry) => entry.kind === "instance" && entry.name === name)
    ?? definitions.find((entry) => entry.kind === "template" && entry.type === (type ?? name))
}

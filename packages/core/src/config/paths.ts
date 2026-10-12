import path from "node:path"
import { Global } from "../global.ts"
import { findUp, exists } from "../util/filesystem.ts"

export const ConfigPaths = {
  // Content roots, global first, nearest project dir last.
  async directories(cwd: string): Promise<string[]> {
    const project = await findUp([".kinex"], cwd)
    const all = [Global.Path.config, ...project.toReversed()]
    return [...new Set(all)]
  },

  // Config files to merge, global first, nearest last (nearest wins on conflict).
  async files(cwd: string): Promise<string[]> {
    const global = [path.join(Global.Path.config, "kinex.json"), path.join(Global.Path.config, "kinex.jsonc")]
    const project = await findUp(
      [
        path.join(".kinex", "kinex.json"),
        path.join(".kinex", "kinex.jsonc"),
        "kinex.json",
        "kinex.jsonc",
      ],
      cwd,
    )
    const found: string[] = []
    for (const file of global) {
      if (await exists(file)) found.push(file)
    }
    return [...found, ...project.toReversed()]
  },

  // The directory that owns project-local state (.kinex/ nearest to cwd, created on demand at cwd).
  async projectDir(cwd: string): Promise<string> {
    const project = await findUp([".kinex"], cwd)
    if (project.length > 0) return project[0]!
    return path.join(cwd, ".kinex")
  },
}

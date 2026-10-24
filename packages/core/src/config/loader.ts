import { readFile } from "node:fs/promises"
import { ConfigPaths } from "./paths.ts"
import { deepMerge } from "../util/json.ts"

// jsonc: strip // and /* */ comments plus trailing commas — enough for hand-written config
function stripJsonc(text: string): string {
  const noComments = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
  return noComments.replace(/,(\s*[}\]])/g, "$1")
}

export async function loadRawConfig(cwd: string): Promise<Record<string, unknown>> {
  const files = await ConfigPaths.files(cwd)
  const state = { merged: {} as Record<string, unknown> }
  for (const file of files) {
    const text = await readFile(file, "utf8")
    const parsed = (() => {
      const raw = stripJsonc(text)
      if (raw.trim() === "") return {}
      return JSON.parse(raw) as Record<string, unknown>
    })()
    state.merged = deepMerge(state.merged, parsed)
  }
  return state.merged
}

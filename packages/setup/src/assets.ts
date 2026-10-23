import path from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../assets/", import.meta.url))
export const Assets = { root, builtin: (name: string) => path.join(root, "builtin", name) }
export const setupSkillRoots: readonly string[] = [Assets.builtin("skill")]

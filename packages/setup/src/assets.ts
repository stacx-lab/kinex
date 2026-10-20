import { Assets as CoreAssets } from "@kinex/core/installation/assets"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../assets/", import.meta.url))
export const Assets = { root, python: (...segments: string[]) => segments[0] === "kinex_ros" ? CoreAssets.python(...segments) : path.join(root, "python", ...segments), builtin: (name: string) => path.join(root, "builtin", name) }
export const setupSkillRoots: readonly string[] = [Assets.builtin("skill")]

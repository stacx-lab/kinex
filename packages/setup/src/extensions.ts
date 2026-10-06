import { createRequire } from "node:module"
import path from "node:path"

const require = createRequire(import.meta.url)

export function setupPiExtensions(): { name: string; path: string }[] {
  return ["pi-web-search", "pi-btw"].map(name => ({
    name,
    path: path.dirname(require.resolve(`${name}/package.json`)),
  }))
}

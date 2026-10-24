import path from "node:path"
import { fileURLToPath } from "node:url"
import { currentScope } from "../scope.ts"

const packaged = fileURLToPath(new URL("../../assets/", import.meta.url))
export const Assets = {
  get root() { return currentScope().assetsRoot ?? packaged },
  builtin: (name: string) => path.join(Assets.root, "builtin", name),
  ros: (...segments: string[]) => path.join(Assets.root, "ros", ...segments),
  python: (...segments: string[]) => path.join(Assets.root, "python", ...segments),
}

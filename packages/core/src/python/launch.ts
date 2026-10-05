import path from "node:path"
import { ProfileStore } from "../device/profile/store.ts"
import { Assets } from "../installation/assets.ts"
import { pythonRuntime } from "./environment.ts"

// Drivers can share workspace SDK helpers. Tools prefer the shipped client that
// implements their dialog; both retain the caller's remaining import paths.
export async function pythonLaunch(cwd: string, kind: "driver" | "tool", interpreter?: string, signal?: AbortSignal) {
  const runtime = await pythonRuntime(cwd, interpreter, signal)
  const lib = path.join(await ProfileStore.workspaceDir(cwd), "lib")
  const paths = kind === "driver" ? [lib, Assets.python()] : [Assets.python(), lib]
  if (process.env.PYTHONPATH) paths.push(process.env.PYTHONPATH)
  return {
    ...runtime,
    env: {
      ...runtime.env,
      PYTHONPATH: paths.join(path.delimiter),
      // Only tool processes activate the stdout dialog. Ordinary imports of
      // kinex helpers in drivers and skill scripts remain side-effect-free.
      ...(kind === "tool" ? { KINEX_TOOL_DIALOG: "1" } : {}),
    },
  }
}

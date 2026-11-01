import path from "node:path"
import { ProfileStore } from "../device/profile/store.ts"
import { Assets } from "../installation/assets.ts"
import { overlayCommand, overlayLaunch } from "./ros-environment.ts"
import { pythonRuntime } from "./environment.ts"

// Device nodes and scripts prefer workspace helpers in .kinex/lib; tools prefer the
// shipped client that implements their dialog. Both keep the caller's import paths.
export async function pythonLaunch(cwd: string, kind: "node" | "tool", interpreter?: string, signal?: AbortSignal) {
  const runtime = await pythonRuntime(cwd, interpreter, signal)
  const lib = path.join(await ProfileStore.workspaceDir(cwd), "lib")
  const paths = kind === "node" ? [lib, Assets.python()] : [Assets.python(), lib]
  if (runtime.env.PYTHONPATH) paths.push(runtime.env.PYTHONPATH)
  return {
    ...runtime,
    command: overlayCommand(runtime.executable, runtime.overlays),
    env: {
      ...runtime.env,
      PYTHONPATH: paths.join(path.delimiter),
      // Only tool processes activate the stdout dialog. Ordinary imports of
      // kinex helpers in nodes and skill scripts remain side-effect-free.
      ...(kind === "tool" ? { KINEX_TOOL_DIALOG: "1" } : {}),
    },
  }
}

// The command and environment that start a launch's executable in directory, its overlays applied (see overlayLaunch).
export function launchIn(launch: { executable: string; overlays: string[]; env: NodeJS.ProcessEnv }, directory: string) {
  return overlayLaunch(launch.executable, launch.overlays, launch.env, directory)
}

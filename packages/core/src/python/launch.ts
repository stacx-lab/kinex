import path from "node:path"
import { ConfigPaths } from "../config/paths.ts"
import { Assets } from "../installation/assets.ts"
import { libRoots } from "../lib/catalog.ts"
import { overlayCommand } from "./ros-environment.ts"
import { pythonRuntime } from "./environment.ts"

// Exec and device nodes import the shipped kinex package; KINEX_LIB adds the other lib
// roots to kinex.lib, nearest first, and KINEX_WORKSPACE names the workspace's .kinex.
export async function pythonLaunch(cwd: string, kind: "node" | "exec", interpreter?: string, signal?: AbortSignal) {
  const runtime = await pythonRuntime(cwd, interpreter, signal)
  // The shipped package's own lib directory is last and already on PYTHONPATH.
  const roots = (await libRoots(cwd)).slice(0, -1).map(root => root.directory)
  return {
    ...runtime,
    command: overlayCommand(runtime.executable, runtime.overlays),
    env: {
      ...runtime.env,
      PYTHONPATH: [Assets.python(), ...(runtime.env.PYTHONPATH ? [runtime.env.PYTHONPATH] : [])].join(path.delimiter),
      KINEX_LIB: roots.join(path.delimiter),
      KINEX_WORKSPACE: await ConfigPaths.projectDir(cwd),
      // Only exec processes activate the stdout dialog. Ordinary imports of
      // kinex in nodes and standalone scripts remain side-effect-free.
      ...(kind === "exec" ? { KINEX_TOOL_DIALOG: "1" } : {}),
    },
  }
}

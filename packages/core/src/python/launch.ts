import path from "node:path"
import { Assets } from "../installation/assets.ts"
import { libRoots } from "../lib/catalog.ts"
import { overlayCommand } from "./ros-environment.ts"
import { pythonRuntime } from "./environment.ts"

// Exec and device nodes import the shipped kinex package; KINEX_LIB adds the workspace
// and global lib roots to kinex.lib, nearest first.
export async function pythonLaunch(cwd: string, kind: "node" | "exec", interpreter?: string, signal?: AbortSignal) {
  const runtime = await pythonRuntime(cwd, interpreter, signal)
  const roots = (await libRoots(cwd)).filter(root => root.origin !== "builtin").map(root => root.directory)
  return {
    ...runtime,
    command: overlayCommand(runtime.executable, runtime.overlays),
    env: {
      ...runtime.env,
      PYTHONPATH: [Assets.python(), ...(runtime.env.PYTHONPATH ? [runtime.env.PYTHONPATH] : [])].join(path.delimiter),
      KINEX_LIB: roots.join(path.delimiter),
      // Only exec processes activate the stdout dialog. Ordinary imports of
      // kinex in nodes and standalone scripts remain side-effect-free.
      ...(kind === "exec" ? { KINEX_TOOL_DIALOG: "1" } : {}),
    },
  }
}

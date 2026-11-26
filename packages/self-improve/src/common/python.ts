import { mkdir, symlink } from "node:fs/promises"
import path from "node:path"
import { PythonSettings } from "@kinex/core/config/config"
import { loadRawConfig } from "@kinex/core/config/loader"
import { pythonEnvironment, pythonRuntime } from "@kinex/core/python/environment"
import { createScope, inScope } from "@kinex/core/scope"
import { deepMerge } from "@kinex/core/util/json"
import { readJson } from "./layout.ts"
import { locked } from "./lock.ts"

// Kinex keeps its Python at <workspace>/.kinex/python and builds it on first use,
// minutes and gigabytes for ROS. The workspaces of a workspace's children share
// one, linked into each.
export async function sharePython(python: string, workspace: string) {
  await mkdir(python, { recursive: true })
  await symlink(python, path.join(workspace, ".kinex", "python"))
}

// The Python settings a worker reads in its sandbox: the global configuration's and
// its own workspace's. On the host the workspace the run belongs to lies above the
// worker's, and its settings are not the worker's, so they are left out here too.
export async function trialPython(workspace: string) {
  // From the filesystem's root, discovery finds only the global configuration.
  const global = await loadRawConfig(path.parse(workspace).root)
  const own = await readJson<Record<string, unknown>>(path.join(workspace, ".kinex", "kinex.json")) ?? {}
  return PythonSettings.parse(deepMerge(global, own)["python"] ?? {})
}

// A ROS build is not safe to run twice at once in one folder: each deletes and
// rebuilds ros/. So a job builds the shared environment before its worker can
// start one of its own, and jobs, which are processes of their own, take turns
// at it. uv locks its own environment, so only ROS providers are prepared here.
export async function preparePython(python: string, workspace: string, signal?: AbortSignal): Promise<unknown> {
  const settings = { python: await trialPython(workspace) }
  return locked(`${python}.lock`, () => inScope(createScope({ settings }), async () => {
    const environment = await pythonEnvironment(workspace)
    if (environment.distro && !environment.present) await pythonRuntime(workspace, undefined, signal)
  }), signal)
}

import { mkdir, symlink } from "node:fs/promises"
import path from "node:path"
import { pythonEnvironment, pythonRuntime } from "@kinex/core/python/environment"
import { createScope, currentScope, inScope } from "@kinex/core/scope"
import { finishJob, type Job, type Result } from "./job.ts"
import { pythonDir, versionDir } from "./layout.ts"
import { install } from "./library.ts"
import type { TrialInput } from "./records.ts"
import type { Run } from "./run.ts"
import { runSession } from "./session.ts"
import { openSim } from "./sim.ts"
import WORKER from "./worker.txt"

// Kinex keeps its Python at <workspace>/.kinex/python and builds it on first use,
// minutes and gigabytes for ROS. Trial workspaces share one, linked into each.
async function sharePython(workspace: string) {
  await mkdir(pythonDir(), { recursive: true })
  await symlink(pythonDir(), path.join(workspace, ".kinex", "python"))
}

// Workers are separate processes, and a ROS build is not safe to run twice at once
// in one folder: each deletes and rebuilds ros/. So this process builds the shared
// environment, one trial at a time, before any worker can start one of its own.
// A fresh scope makes the trial workspace's settings decide, not the scheduler's.
// uv locks its own environment, so only ROS providers are prepared here.
let building: Promise<unknown> = Promise.resolve()
function preparePython(workspace: string, signal?: AbortSignal): Promise<unknown> {
  const ready = building.catch(() => {}).then(() => inScope(createScope(), async () => {
    const environment = await pythonEnvironment(workspace)
    if (environment.distro && !environment.present) await pythonRuntime(workspace, undefined, signal)
  }))
  building = ready
  return ready
}

/** One trial: a fresh episode of one task, a fresh worker with one library version, the simulator's verdict. */
export async function runTrial(run: Run, job: Job, input: TrialInput): Promise<Result> {
  const sim = await openSim(run.config.rosbridge, input, job.workspace)
  const session = await (async () => {
    await install(versionDir(run.root, input.library), job.workspace)
    await sharePython(job.workspace)
    await preparePython(job.workspace, currentScope().signal)
    const prompt = `${sim.instruction}\n\n${WORKER.trim().replaceAll("$TIMEOUT", String(input.timeoutS))}`
    return runSession("worker", job.workspace, job.record, prompt, Date.now() + input.timeoutS * 1000)
  })().catch(async (error: unknown) => { await sim.close().catch(() => {}); throw error })
  return finishJob(job, { ...session, instruction: sim.instruction, ...await sim.close() })
}

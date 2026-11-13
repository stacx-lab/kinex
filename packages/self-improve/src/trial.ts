import { mkdir, symlink } from "node:fs/promises"
import path from "node:path"
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

/** One trial: a fresh episode of one task, a fresh worker with one library version, the simulator's verdict. */
export async function runTrial(run: Run, job: Job, input: TrialInput): Promise<Result> {
  const sim = await openSim(run.config.rosbridge, input, job.workspace)
  const session = await (async () => {
    await install(versionDir(run.root, input.library), job.workspace)
    await sharePython(job.workspace)
    const prompt = `${sim.instruction}\n\n${WORKER.trim().replaceAll("$TIMEOUT", String(input.timeoutS))}`
    return runSession("worker", job.workspace, job.record, prompt, Date.now() + input.timeoutS * 1000)
  })().catch(async (error: unknown) => { await sim.close().catch(() => {}); throw error })
  return finishJob(job, { ...session, instruction: sim.instruction, ...await sim.close() })
}

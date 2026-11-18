import { mkdir, symlink } from "node:fs/promises"
import path from "node:path"
import { pythonEnvironment, pythonRuntime } from "@kinex/core/python/environment"
import { createScope, currentScope, inScope } from "@kinex/core/scope"
import { finishJob, spaced, type Job, type Result } from "./job.ts"
import { pythonDir, versionDir } from "./layout.ts"
import { install } from "./library.ts"
import { writeRecord, type TrialInput } from "./records.ts"
import { START_GAP_S, type Run } from "./run.ts"
import { sandboxReady } from "./sandbox.ts"
import { runSession, type SessionExit } from "./session.ts"
import { openSim, type Verdict } from "./sim.ts"
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
// uv locks its own environment, so only ROS providers are prepared here. The
// folder is one for the whole process, so the queue is too, not a runtime's.
let building: Promise<unknown> = Promise.resolve()
function preparePython(workspace: string, signal?: AbortSignal): Promise<unknown> {
  const ready = building.catch(() => {}).then(() => inScope(createScope(), async () => {
    const environment = await pythonEnvironment(workspace)
    if (environment.distro && !environment.present) await pythonRuntime(workspace, undefined, signal)
  }))
  building = ready
  return ready
}

// Whether a trial ran is the simulator's to say, not the worker's exit code: a
// worker that exits non-zero after its episode advanced (a device that loaded
// late, say) was still judged, and its exit is kept as a note. Only a worker
// that failed before the simulation moved leaves a trial that did not run.
export function judged(session: SessionExit, verdict: Verdict): SessionExit & { note?: string; error?: string } {
  if (session.status !== "error") return session
  const exit = `worker exited ${session.exitCode}`
  return verdict.steps === 0 ? { ...session, error: `${exit} before the simulation advanced; see output.log` }
    : { ...session, status: "done", note: `${exit}; see output.log` }
}

/** One trial: a fresh episode of one task, a fresh worker with one library version, the simulator's verdict. */
export async function runTrial(run: Run, job: Job, input: TrialInput): Promise<Result> {
  const sandbox = run.config.sandbox === true
  if (sandbox) await sandboxReady()
  const sim = await openSim(run.config.rosbridge, input, job.workspace)
  const session = await (async () => {
    await install(versionDir(run.root, input.library), job.workspace)
    await sharePython(job.workspace)
    await preparePython(job.workspace, currentScope().signal)
    // Each worker starts a ROS process per device: workers started in the same
    // moment time each other's device loads out. Simulators still launch together.
    await spaced("workers", run.config.startGapS ?? START_GAP_S)
    const prompt = `${sim.instruction}\n\n${WORKER.trim().replaceAll("$TIMEOUT", String(input.timeoutS))}`
    return runSession("worker", job.workspace, job.record, prompt, Date.now() + input.timeoutS * 1000, sandbox)
  })().catch(async (error: unknown) => { await sim.close().catch(() => {}); throw error })
  const verdict = await sim.close()
  const outcome = { ...judged(session, verdict), instruction: sim.instruction, ...verdict }
  // A record that cannot be written must not cost the trial its verdict: the distillation writes it again.
  const unwritten = await writeRecord(run.root, { id: job.id, ...input, ...outcome }).then(() => undefined, (error: unknown) => error instanceof Error ? error.message : String(error))
  return finishJob(job, { ...outcome, ...(unwritten ? { recordError: unwritten } : {}) })
}

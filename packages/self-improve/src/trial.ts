import { mkdir, readFile, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { pythonEnvironment, pythonRuntime } from "@kinex/core/python/environment"
import { createScope, currentScope, inScope } from "@kinex/core/scope"
import { finishJob, type Job, type Result } from "./job.ts"
import { pythonDir, runsDir, versionDir } from "./layout.ts"
import { install } from "./library.ts"
import { locked } from "./lock.ts"
import { writeRecord, type TrialInput } from "./records.ts"
import { START_GAP_S, type Run } from "./run.ts"
import { sandboxOf } from "./sandbox.ts"
import { runSession, type SessionExit } from "./session.ts"
import { openSim, type Verdict } from "./sim.ts"
import WORKER from "./worker.txt"

// Kinex keeps its Python at <workspace>/.kinex/python and builds it on first use,
// minutes and gigabytes for ROS. Trial workspaces share one, linked into each.
async function sharePython(workspace: string) {
  await mkdir(pythonDir(), { recursive: true })
  await symlink(pythonDir(), path.join(workspace, ".kinex", "python"))
}

// A ROS build is not safe to run twice at once in one folder: each deletes and
// rebuilds ros/. So a trial builds the shared environment before its worker can
// start one of its own, and trials, which are processes of their own, take turns
// at it. A fresh scope makes the trial workspace's settings decide, not the
// run's. uv locks its own environment, so only ROS providers are prepared here.
function preparePython(workspace: string, signal?: AbortSignal): Promise<unknown> {
  return locked(path.join(runsDir(), ".python.lock"), () => inScope(createScope(), async () => {
    const environment = await pythonEnvironment(workspace)
    if (environment.distro && !environment.present) await pythonRuntime(workspace, undefined, signal)
  }), signal)
}

// Work that must not begin at the same moment takes turns: each worker's turn
// comes no sooner than `gapS` after the one before it, whichever trial it is in.
async function spaced(gapS: number, signal?: AbortSignal): Promise<void> {
  const last = path.join(runsDir(), ".start")
  const mine = await locked(path.join(runsDir(), ".start.lock"), async () => {
    const turn = Math.max(Date.now(), Number(await readFile(last, "utf8").catch(() => "")) + gapS * 1000 || 0)
    await writeFile(last, String(turn))
    return turn
  }, signal)
  await new Promise(resolve => setTimeout(resolve, Math.max(0, mine - Date.now())))
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

// rosbridge does not report an episode's step limit, so a worker is told the
// number only once an earlier trial of its task has been ended at it.
const limitNote = (limit: TrialInput["limit"]) => limit
  ? ` An earlier trial of this task was ended at that limit after ${limit.steps} steps${limit.worldS === undefined ? "" : ` (${limit.worldS.toFixed(1)} s of world time)`}.` : ""

/** One trial: a fresh episode of one task, a fresh worker with one library version, the simulator's verdict. */
export async function runTrial(run: Run, job: Job, input: TrialInput, signal: AbortSignal): Promise<Result> {
  const sandbox = await sandboxOf(run.config.sandbox, run.config.image)
  const sim = await openSim(run.config.rosbridge, input, job.workspace)
  const session = await (async () => {
    await install(versionDir(run.root, input.library), job.workspace)
    await sharePython(job.workspace)
    await preparePython(job.workspace, currentScope().signal)
    // Each worker starts a ROS process per device: workers started in the same
    // moment time each other's device loads out. Simulators still launch together.
    await spaced(run.config.startGapS ?? START_GAP_S, signal)
    const prompt = `${sim.instruction.text}\n\n${WORKER.trim().replaceAll("$TIMEOUT", String(input.timeoutS)).replaceAll("$LIMIT", () => limitNote(input.limit))}`
    return runSession("worker", job.workspace, job.record, prompt, Date.now() + input.timeoutS * 1000, { sandbox, image: run.config.image, signal })
  })().catch(async (error: unknown) => { await sim.close().catch(() => {}); throw error })
  const verdict = await sim.close()
  const outcome = { ...judged(session, verdict), instruction: sim.instruction.text, instructionSource: sim.instruction.source, ...verdict }
  // A record that cannot be written must not cost the trial its verdict: the distillation writes it again.
  const unwritten = await writeRecord(run.root, { id: job.id, ...input, ...outcome }).then(() => undefined, (error: unknown) => error instanceof Error ? error.message : String(error))
  return finishJob(job, { ...outcome, ...(unwritten ? { recordError: unwritten } : {}) })
}

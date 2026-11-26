import { currentScope } from "@kinex/core/scope"
import { judged, spaced } from "../../common/episode.ts"
import { finishJob, type Job, type Result } from "../../common/job.ts"
import { homeOf, pythonDir } from "../../common/layout.ts"
import { preparePython, sharePython } from "../../common/python.ts"
import { START_GAP_S } from "../../common/run.ts"
import { sandboxOf } from "../../common/sandbox.ts"
import { runSession } from "../../common/session.ts"
import { openSim } from "../../common/sim.ts"
import { versionDir } from "./layout.ts"
import { install } from "./library.ts"
import { writeRecord, type TrialInput } from "./records.ts"
import { WORKER as ROLE } from "./roles.ts"
import type { Run } from "./run.ts"
import WORKER from "./worker.txt"

// kinex-sim does not report an episode's step limit, so a worker is told the
// number only once an earlier trial of its task has been ended at it.
const limitNote = (limit: TrialInput["limit"]) => limit
  ? ` An earlier trial of this task was ended at that limit after ${limit.steps} steps${limit.worldS === undefined ? "" : ` (${limit.worldS.toFixed(1)} s of world time)`}.` : ""

/** One trial: a fresh episode of one task, a fresh worker with one library version, the simulator's verdict. */
export async function runTrial(run: Run, job: Job, input: TrialInput, signal: AbortSignal): Promise<Result> {
  const python = pythonDir(homeOf(run.root))
  const confinement = { sandbox: await sandboxOf({ image: run.config.image, python }), image: run.config.image, python }
  const sim = await openSim(run.config.command, { ...input, launch: run.config.launch, record: job.record }, job.workspace)
  const session = await (async () => {
    await install(versionDir(run.root, input.library), job.workspace)
    await sharePython(python, job.workspace)
    await preparePython(python, job.workspace, currentScope().signal)
    // Each worker starts a ROS process per device: workers started in the same
    // moment time each other's device loads out. Simulators still launch together.
    await spaced(run.config.startGapS ?? START_GAP_S, signal)
    const prompt = `${sim.instruction.text}\n\n${WORKER.trim().replaceAll("$TIMEOUT", String(input.timeoutS)).replaceAll("$LIMIT", () => limitNote(input.limit))}`
    return runSession(ROLE, job.workspace, job.record, prompt, Date.now() + input.timeoutS * 1000, { ...confinement, signal })
  })().catch(async (error: unknown) => { await sim.close().catch(() => {}); throw error })
  const verdict = await sim.close()
  const outcome = { ...judged(session, verdict), instruction: sim.instruction.text, instructionSource: sim.instruction.source, ...verdict }
  // A record that cannot be written must not cost the trial its verdict: the distillation writes it again.
  const unwritten = await writeRecord(run.root, { id: job.id, ...input, ...outcome }).then(() => undefined, (error: unknown) => error instanceof Error ? error.message : String(error))
  return finishJob(job, { ...outcome, ...(unwritten ? { recordError: unwritten } : {}) })
}

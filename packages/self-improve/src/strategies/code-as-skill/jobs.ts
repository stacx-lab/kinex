import { finishJob, type Result } from "../../common/job.ts"
import { inputFile, readJson, recordDir } from "../../common/layout.ts"
import { openRunAt } from "../../common/run.ts"
import { Refused } from "../../common/schedule.ts"
import type { JobCall, JobKind } from "../../common/strategy.ts"
import { runDistillation } from "./distill.ts"
import { DISTILL, NEXT, TRIAL } from "./names.ts"
import { describeDistillation, describeTrial, type DistillInput, type TrialInput } from "./records.ts"
import { REPAIRS, REPAIR_S, type Config } from "./run.ts"
import { admit } from "./scheduler.ts"
import { runTrial } from "./trial.ts"

const message = (error: unknown) => error instanceof Error ? error.message : String(error)

// A job ends itself at its run's limit for it, counted from when the scheduler admitted it.
// A trial that fails still leaves a result, so it counts as finished: it did not run, and its task is tried again.
async function trial({ root, words, signal, within }: JobCall): Promise<string> {
  if (!words.task) throw new Refused("The call names no task")
  if (words.library && !/^L\d+$/.test(words.library)) throw new Refused(`${words.library} is not a library version, such as L1`)
  const run = await openRunAt<Config>(root)
  const job = await admit(run, { task: words.task, ...(words.library ? { library: words.library } : {}) }, signal)
  within(run.config.trialTimeoutS)
  const input = await readJson<TrialInput>(inputFile(job.directory))
  const result: Result = await runTrial(run, job, input!, signal).catch((error: unknown) => finishJob(job, { status: "error", error: message(error) }))
  return `${describeTrial({ id: job.id, ...input!, ...result }, false)}\nIts record: ${recordDir(job.directory)} (summary.md first).`
}

async function distill({ root, signal, within }: JobCall): Promise<string> {
  const run = await openRunAt<Config>(root)
  const job = await admit(run, "distill", signal)
  within(run.config.distillTimeoutS + REPAIRS * REPAIR_S)
  const input = await readJson<DistillInput>(inputFile(job.directory))
  const result: Result = await runDistillation(run, job, input!, signal).catch((error: unknown) => finishJob(job, { status: "error", error: message(error) }))
  return `${describeDistillation({ id: job.id, ...input!, ...result }, false)}\nIts record: ${recordDir(job.directory)}.\nCall ${NEXT}.`
}

//   run=<run folder> task=<task> [library=<version>] for a trial, run=<run folder> for a distillation
export const jobs: Record<string, JobKind> = {
  [TRIAL]: { what: "trial", words: ["task", "library"], run: trial },
  [DISTILL]: { what: "distillation", run: distill },
}

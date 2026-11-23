import path from "node:path"
import { text } from "node:stream/consumers"
import { createScope, inScope, withSignal } from "@kinex/core/scope"
import { runDistillation } from "./distill.ts"
import type { Scheduler } from "./agents.ts"
import { claim, finishJob, jobAt, namedJobs, type Job, type Result } from "./job.ts"
import { distillationsDir, entries, inputFile, kinexFile, readJson, recordDir, resultFile, runsDir, trialsDir } from "./layout.ts"
import { kinex } from "./kinex.ts"
import { describeDistillation, describeTrial, type DistillInput, type TrialInput } from "./records.ts"
import { REPAIRS, REPAIR_S, openRunAt, type Run } from "./run.ts"
import { runTrial } from "./trial.ts"

// The process of one job: a background sub-agent that improve_next named runs
// this command, which claims a trial or a distillation the scheduler opened,
// does it, and says in a line how it ended. What it prints is what the session
// that started it is told.
//   node main.js <trial|distill>, with the job's name on standard input: <run>/<id>
const [kind] = process.argv.slice(2)
if (kind !== "trial" && kind !== "distill") throw new Error("Usage: main.js <trial|distill>, with <run>/<job id> on standard input")
const what = kind === "trial" ? "trial" : "distillation"

const message = (error: unknown) => error instanceof Error ? error.message : String(error)

// What a job's process may take beyond its session: launching a simulator, a first build of the shared Python environment, records.
const SLACK_S = 3600

/** The run the call names, and the job's id in it. */
async function named(text: string): Promise<{ run: Run; id: string } | undefined> {
  for (const { run, id } of namedJobs(text, kind === "trial" ? "t" : "d")) {
    const found = await openRunAt(path.join(runsDir(), run)).catch(() => undefined)
    if (found) return { run: found, id }
  }
  return undefined
}

// The job the call names, else the oldest that waits: the scheduler opened exactly the jobs to do.
async function take(directory: string, id: string): Promise<Job | undefined> {
  const waiting = (await entries(directory)).sort((a, b) => Number(b === id) - Number(a === id))
  for (const id of waiting) {
    const job = jobAt(path.join(directory, id))
    if (await readJson(resultFile(job.directory)) === undefined && await readJson(inputFile(job.directory)) !== undefined && await claim(job)) return job
  }
  return undefined
}

async function work(run: Run, id: string, signal: AbortSignal): Promise<string> {
  const job = await take(kind === "trial" ? trialsDir(run.root) : distillationsDir(run.root), id)
  if (!job) return `No ${what} waits to be started. Call improve_next.`
  if (kind === "trial") {
    const input = await readJson<TrialInput>(inputFile(job.directory))
    // A trial that fails still leaves a result, so it counts as finished: it did not run, and its task is started again.
    const result: Result = await runTrial(run, job, input!, signal).catch((error: unknown) => finishJob(job, { status: "error", error: message(error) }))
    return `${describeTrial({ id: job.id, ...input!, ...result }, false)}\nIts record: ${recordDir(job.directory)} (summary.md first).\nCall improve_next.`
  }
  const input = await readJson<DistillInput>(inputFile(job.directory))
  const result: Result = await runDistillation(run, job, input!, signal).catch((error: unknown) => finishJob(job, { status: "error", error: message(error) }))
  return `${describeDistillation({ id: job.id, ...input!, ...result }, false)}\nIts record: ${recordDir(job.directory)}.\nCall improve_next.`
}

// Stopping the sub-agent, /self-improve stop and the job's own deadline all end the
// job the same way: its children are stopped, its simulator is closed, and it
// leaves no result, so it counts as abandoned, not failed.
async function main(): Promise<void> {
  const job = await named(await text(process.stdin))
  const scheduler = job && await readJson<Scheduler>(kinexFile(job.run.root))
  if (!job || !scheduler) {
    console.log(`No self-improve ${what} is named. Start this sub-agent only with the task improve_next gives. Call improve_next.`)
    process.exitCode = 1
    return
  }
  kinex.entry = scheduler.entry
  kinex.args = scheduler.flags
  const { run } = job
  const abort = new AbortController()
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => abort.abort(new Error("The job was stopped")))
  const limitS = kind === "trial" ? run.config.trialTimeoutS : run.config.distillTimeoutS + REPAIRS * REPAIR_S
  const deadline = setTimeout(() => abort.abort(new Error("The job ran past its deadline")), (limitS + SLACK_S) * 1000)
  const scope = createScope(run.config.libRoots ? { builtinLibRoots: run.config.libRoots } : {})
  scope.signal = abort.signal
  try {
    console.log(await inScope(scope, () => withSignal(abort.signal, () => work(run, job.id, abort.signal))))
  } catch (error) {
    console.log(abort.signal.aborted ? `The ${what} was stopped and left no result. Call improve_next.` : `The ${what} failed: ${message(error)}. Call improve_next.`)
    process.exitCode = 1
  } finally {
    clearTimeout(deadline)
    scope.closed = true
  }
}
await main()

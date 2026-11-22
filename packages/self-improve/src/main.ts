import path from "node:path"
import { text } from "node:stream/consumers"
import { createScope, inScope, withSignal } from "@kinex/core/scope"
import { runDistillation } from "./distill.ts"
import { claim, finishJob, jobAt, type Job, type Result } from "./job.ts"
import { distillationsDir, entries, inputFile, readJson, recordDir, resultFile, trialsDir } from "./layout.ts"
import { kinex } from "./kinex.ts"
import { describeDistillation, describeTrial, type DistillInput, type TrialInput } from "./records.ts"
import { openRunAt } from "./run.ts"
import { runTrial } from "./trial.ts"

// The process of one job: a background sub-agent that improve_next named runs
// this command, which claims a trial or a distillation the scheduler opened,
// does it, and says in a line how it ended. What it prints is what the session
// that started it is told.
//   node main.js <trial|distill> <run folder> <Kinex entry point> [Kinex's model flags]
const [kind, root, entry, ...args] = process.argv.slice(2)
if ((kind !== "trial" && kind !== "distill") || !root || !entry) throw new Error("Usage: main.js <trial|distill> <run folder> <Kinex entry point> [flags]")
kinex.entry = entry
kinex.args = args

const message = (error: unknown) => error instanceof Error ? error.message : String(error)

// The job the call names, else the oldest that waits: the scheduler opened exactly the jobs to do.
async function take(directory: string, named: string): Promise<Job | undefined> {
  const waiting = (await entries(directory)).sort((a, b) => Number(named.includes(b)) - Number(named.includes(a)))
  for (const id of waiting) {
    const job = jobAt(path.join(directory, id))
    if (await readJson(resultFile(job.directory)) === undefined && await readJson(inputFile(job.directory)) !== undefined && await claim(job)) return job
  }
  return undefined
}

async function work(signal: AbortSignal): Promise<string> {
  const run = await openRunAt(root!)
  const job = await take(kind === "trial" ? trialsDir(run.root) : distillationsDir(run.root), await text(process.stdin))
  if (!job) return `No ${kind === "trial" ? "trial" : "distillation"} waits to be started. Call improve_next.`
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

// Stopping the sub-agent, /self-improve stop and a deadline of its own all end the
// job the same way: its children are stopped, its simulator is closed, and it
// leaves no result, so it counts as abandoned, not failed.
const abort = new AbortController()
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => abort.abort(new Error("The job was stopped")))
const libRoots = (await openRunAt(root).catch(() => undefined))?.config.libRoots
const scope = createScope(libRoots ? { builtinLibRoots: libRoots } : {})
scope.signal = abort.signal
try {
  console.log(await inScope(scope, () => withSignal(abort.signal, () => work(abort.signal))))
} catch (error) {
  console.log(abort.signal.aborted ? `The ${kind} was stopped and left no result. Call improve_next.` : `The ${kind} failed: ${message(error)}. Call improve_next.`)
  process.exitCode = 1
} finally { scope.closed = true }

import path from "node:path"
import { text } from "node:stream/consumers"
import { z } from "zod"
import { createScope, inScope, withSignal } from "@kinex/core/scope"
import { runDistillation } from "./distill.ts"
import type { Scheduler } from "./agents.ts"
import { heartbeat } from "./heartbeat.ts"
import { finishJob, type Result } from "./job.ts"
import { inputFile, readJson, recordDir, schedulerFile } from "./layout.ts"
import { kinex } from "./kinex.ts"
import { describeDistillation, describeTrial, type DistillInput, type TrialInput } from "./records.ts"
import { REPAIRS, REPAIR_S, openRunAt, type Run } from "./run.ts"
import { Refused, admit } from "./scheduler.ts"
import { runTrial } from "./trial.ts"

// The process of one job: a background sub-agent the session started runs this
// command, which asks the scheduler for the trial or the distillation its call
// names, does it, and says in a line how it ended. What it prints is what the
// session that started it is told; while it works it writes newlines to standard
// error, so that pi-subagents sees it at work (heartbeat.ts).
//   node main.js <trial|distill>, with the call's words on standard input:
//   run=<run folder> for a distillation, run=<run folder> task=<task> [library=<version>] for a trial
// A value is a word, or a JSON string where it holds a space or a quote.
const [kind] = process.argv.slice(2)
if (kind !== "trial" && kind !== "distill") throw new Error("Usage: main.js <trial|distill>, with run=<run folder> [task=<task>] [library=<version>] on standard input")
const what = kind === "trial" ? "trial" : "distillation"

const message = (error: unknown) => error instanceof Error ? error.message : String(error)

// What a job's process may take beyond its session: launching a simulator, a first build of the shared Python environment, records.
const SLACK_S = 3600

/** What the call says: the words on standard input, where the last word of a name counts. */
const Call = z.object({ run: z.string().refine(value => path.isAbsolute(value)), task: z.string().optional(), library: z.string().regex(/^L\d+$/).optional() })
const value = (written: string) => written.startsWith('"') ? JSON.parse(written) as string : written
const said = (text: string) => Call.safeParse(Object.fromEntries([...text.matchAll(/\b(run|task|library)=("(?:[^"\\]|\\.)*"|[^\s"'`]+)/g)].map(([, name, written]) => [name, value(written!)]))).data

// A job ends itself at its run's limit for it, counted from when the scheduler admitted it.
async function work(run: Run, call: z.infer<typeof Call>, signal: AbortSignal, within: (seconds: number) => void): Promise<string> {
  if (kind === "trial") {
    if (!call.task) throw new Refused("The call names no task")
    const job = await admit(run, { task: call.task, ...(call.library ? { library: call.library } : {}) }, signal)
    within(run.config.trialTimeoutS)
    const input = await readJson<TrialInput>(inputFile(job.directory))
    // A trial that fails still leaves a result, so it counts as finished: it did not run, and its task is tried again.
    const result: Result = await runTrial(run, job, input!, signal).catch((error: unknown) => finishJob(job, { status: "error", error: message(error) }))
    return `${describeTrial({ id: job.id, ...input!, ...result }, false)}\nIts record: ${recordDir(job.directory)} (summary.md first).`
  }
  const job = await admit(run, "distill", signal)
  within(run.config.distillTimeoutS + REPAIRS * REPAIR_S)
  const input = await readJson<DistillInput>(inputFile(job.directory))
  const result: Result = await runDistillation(run, job, input!, signal).catch((error: unknown) => finishJob(job, { status: "error", error: message(error) }))
  return `${describeDistillation({ id: job.id, ...input!, ...result }, false)}\nIts record: ${recordDir(job.directory)}.\nCall improve_next.`
}

// Stopping the sub-agent, /self-improve stop and the job's own deadline all end the
// job the same way: its children are stopped, its simulator is closed, and it
// leaves no result, so it counts as abandoned, not failed.
async function main(): Promise<void> {
  const call = said(await text(process.stdin))
  const run = call && await openRunAt(call.run).catch(() => undefined)
  const scheduler = run && await readJson<Scheduler>(schedulerFile(run.root))
  if (!call || !run || !scheduler) {
    console.log(`No self-improve run is named. Start this sub-agent only with the call improve_next gives. Call improve_next.`)
    return
  }
  kinex.entry = scheduler.entry
  kinex.args = scheduler.flags
  const abort = new AbortController()
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => abort.abort(new Error("The job was stopped")))
  const stopBeat = heartbeat(text => process.stderr.write(text))
  let deadline: NodeJS.Timeout | undefined
  const within = (seconds: number) => { deadline = setTimeout(() => abort.abort(new Error("The job ran past its deadline")), (seconds + SLACK_S) * 1000) }
  const scope = createScope(run.config.libRoots ? { builtinLibRoots: run.config.libRoots } : {})
  scope.signal = abort.signal
  try {
    console.log(await inScope(scope, () => withSignal(abort.signal, () => work(run, call, abort.signal, within))))
  } catch (error) {
    // A job the scheduler does not have to do is an answer, not a failure of the sub-agent.
    if (error instanceof Refused) { console.log(`Not started: ${error.message}. Call improve_next.`); return }
    console.log(abort.signal.aborted ? `The ${what} was stopped and left no result. Call improve_next.` : `The ${what} failed: ${message(error)}. Call improve_next.`)
    process.exitCode = 1
  } finally {
    stopBeat()
    clearTimeout(deadline)
    scope.closed = true
  }
}
await main()

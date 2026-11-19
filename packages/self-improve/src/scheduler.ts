import type { Turn } from "@kinex/core"
import { createScope, inScope, withSignal } from "@kinex/core/scope"
import { createJobs, type Jobs } from "@kinex/jobs"
import { finishDistillation, prepareDistillation, type Distillation } from "./distill.ts"
import { finishJob, openJob, type Result } from "./job.ts"
import { sessionFile, trialsDir } from "./layout.ts"
import { newestVersion } from "./library.ts"
import { renderStatus, scan, solvedTasks, stepLimits, type Status, type TrialInput } from "./records.ts"
import { HELPERS, saveTasks, type Run } from "./run.ts"
import { listTasks, matching, type Task } from "./sim.ts"
import { runTrial } from "./trial.ts"
import SELECT from "./select.txt"

// The scheduler is code: one loop that reads a run's folder, starts a wave of
// trials for the tasks still unsolved, and gives the main session a turn to
// distill each wave into the next library version. A run belongs to the Kinex
// process, not to a session or a workspace, because the main session leaves its
// workspace for every distillation. One run is scheduled at a time.

/** What the scheduler asks of the session in front of the user. */
export interface Host { turn(turn: Turn, signal?: AbortSignal): Promise<void> }

// What the main session is doing for the run right now, which decides the tools it has.
export type Phase = { kind: "select"; catalog: readonly Task[] } | { kind: "distill"; distillation: Distillation; helpers: Jobs }
export interface Scheduled {
  run: Run
  /** The trials of the wave in progress. */
  jobs: Jobs
  phase?: Phase
  /** Ends the run's work at once; what finished stays on disk and /self-improve resume continues from it. */
  stop(): void
  /** What to tell the user when the run has ended. */
  ended: Promise<string>
}

let scheduled: Scheduled | undefined
export const current = () => scheduled
/** Whether a job of the run is alive in this process: one without a result that is not is abandoned. */
export const running = (root: string) => (id: string) => scheduled?.run.root === root &&
  ((scheduled.phase?.kind === "distill" && scheduled.phase.distillation.job.id === id) || (scheduled.jobs.get(id)?.state ?? "ended") !== "ended")

const message = (error: unknown) => error instanceof Error ? error.message : String(error)

/** The tasks a request names outright, by id or pattern; undefined when a part of it is neither, which only a model can read. */
export function named(request: string, catalog: readonly Task[]): string[] | undefined {
  const ids = new Set<string>()
  for (const part of request.split(/\s+/).filter(Boolean)) {
    const found = catalog.filter(task => matching(part).test(task.id))
    if (!found.length) return undefined
    for (const task of found) ids.add(task.id)
  }
  return ids.size ? [...ids] : undefined
}

/** The ids as a run's tasks: every one in the catalog, all on one robot. */
export function checked(ids: readonly string[], catalog: readonly Task[]): string[] {
  const robots = new Map(catalog.map(task => [task.id, task.robot]))
  const unknown = ids.filter(id => !robots.has(id))
  if (unknown.length) throw new Error(`Unknown tasks: ${unknown.join(", ")}; improve_tasks lists the ids`)
  const used = [...new Set(ids.map(id => robots.get(id)))]
  if (used.length !== 1) throw new Error(used.length ? `The tasks use different robots (${used.join(", ")}); a run practises on one` : "A run needs at least one task")
  return [...new Set(ids)].sort()
}

// The request is converted once. Ids and patterns are matched here; anything else
// is free text, which the main session reads in one short turn and answers with improve_select.
async function tasksOf(state: Scheduled, host: Host, catalog: readonly Task[], signal: AbortSignal): Promise<string[]> {
  const { run } = state
  const direct = run.config.tasks ?? named(run.config.selection, catalog)
  if (direct) {
    if (!run.config.tasks) await saveTasks(run, checked(direct, catalog))
    return checked(direct, catalog)
  }
  state.phase = { kind: "select", catalog }
  try { await host.turn({ prompt: SELECT.trim().replaceAll("$REQUEST", () => run.config.selection) }, signal) }
  finally { state.phase = undefined }
  if (!run.config.tasks) throw new Error("no tasks were selected for the request")
  return run.config.tasks
}

// One trial for each task with the newest library. A trial that ends with status
// error did not run, which is a setup problem and not a task failure: it is
// started once more, and a second error ends the run.
async function wave(state: Scheduled, tasks: readonly string[], robots: ReadonlyMap<string, string>, limits: ReturnType<typeof stepLimits>, signal: AbortSignal): Promise<void> {
  const { run, jobs } = state
  const attempt = async (wanted: readonly string[]) => {
    const library = await newestVersion(run.root)
    const ids: string[] = []
    for (const task of wanted) {
      const limit = limits.get(task)
      const input: TrialInput = { task, robot: robots.get(task) ?? "", library, ...(run.config.seed === undefined ? {} : { seed: run.config.seed }), timeoutS: run.config.trialTimeoutS, ...(limit ? { limit } : {}) }
      const job = await openJob(trialsDir(run.root), "t", input)
      // A trial that fails still leaves a result, so it counts as finished.
      const trial = (stop: AbortSignal): Promise<Result> => runTrial(run, job, input, stop).catch((error: unknown) => finishJob(job, { status: "error", error: message(error) }))
      jobs.start({ id: job.id, lane: "trials", record: job.record, run: async stop => ({ status: (await trial(stop)).status }) })
      ids.push(job.id)
    }
    await jobs.wait(ids, { signal })
    return (await scan(run.root)).trials.filter(trial => ids.includes(trial.id) && trial.status === "error")
  }
  const failed = await attempt(tasks)
  const again = failed.length ? await attempt(failed.map(trial => trial.task)) : []
  if (again.length) throw new Error(`these trials did not run, twice: ${again.map(trial => `${trial.id} (${trial.task}): ${trial.error}`).join("; ")}`)
}

// One turn of the main session, in the distillation's own folder and session. Its
// sub-agents are jobs of this turn and end with it. Only a turn that ended normally can publish.
async function distill(state: Scheduled, host: Host, status: Status, signal: AbortSignal): Promise<Result> {
  const { run } = state
  const distillation = await prepareDistillation(run, status)
  const helpers = createJobs({ limits: { helpers: run.config.helpers ?? HELPERS } })
  const started = Date.now()
  const deadline = AbortSignal.timeout(Math.max(0, distillation.deadline - started))
  state.phase = { kind: "distill", distillation, helpers }
  const exit = await host.turn({ prompt: distillation.prompt, directory: distillation.job.workspace, session: sessionFile(distillation.job.record) }, AbortSignal.any([signal, deadline]))
    .then(() => ({ status: "done" as const }), (error: unknown) => deadline.aborted ? { status: "timeout" as const } : { status: "error" as const, error: message(error) })
    .finally(() => { helpers.stop(); state.phase = undefined })
  signal.throwIfAborted()
  return finishDistillation(run, distillation, { ...exit, wallS: Math.round((Date.now() - started) / 1000) })
}

// Every pass decides the next step from the run's folder alone, so a run that
// was stopped continues where it is. A wave not yet given to a finished
// distillation is distilled; otherwise the next wave runs.
async function schedule(state: Scheduled, host: Host, signal: AbortSignal): Promise<string> {
  const { run } = state
  const catalog = await listTasks(run.config.rosbridge)
  const tasks = await tasksOf(state, host, catalog, signal)
  const robots = new Map(catalog.map(task => [task.id, task.robot]))
  for (;;) {
    signal.throwIfAborted()
    const status = await scan(run.root)
    const solved = solvedTasks(status)
    const unsolved = tasks.filter(task => !solved.has(task))
    if (!unsolved.length) return "every task is solved"
    const finished = status.distillations.filter(distillation => distillation.status)
    if (finished.length >= run.config.rounds) return "its rounds are done"
    const distilled = new Set(finished.flatMap(distillation => distillation.trials))
    const waiting = status.trials.filter(trial => trial.status && !distilled.has(trial.id))
    if (!waiting.length) { await wave(state, unsolved, robots, stepLimits(status), signal); continue }
    const result = await distill(state, host, status, signal)
    if (!result.version && !waiting.some(trial => trial.success)) return "the last round neither solved a task nor published a library version"
  }
}

const report = async (run: Run, how: string, next: string) =>
  `The self-improve run ${run.root} ${how}.\n\n${renderStatus(run.root, await scan(run.root), () => false)}\n\n${next}`

// Quitting ends the run with the process: the children of its trials are stopped when it exits.
const exit = { watched: false }

/** Starts scheduling a run in this process and returns at once. */
export function start(run: Run, host: Host): Scheduled {
  if (scheduled) throw new Error(`The self-improve run ${scheduled.run.root} is already scheduled in this Kinex; /self-improve stop ends it`)
  const abort = new AbortController()
  // The run's own scope: its children are not those of the workspace a session happens to be in.
  const scope = createScope()
  scope.signal = abort.signal
  const state: Scheduled = {
    run, jobs: createJobs({ limits: { trials: run.config.parallel } }), ended: Promise.resolve(""),
    stop() {
      abort.abort(new Error("The self-improve run was stopped"))
      state.jobs.stop()
      if (state.phase?.kind === "distill") state.phase.helpers.stop()
    },
  }
  state.ended = inScope(scope, () => withSignal(abort.signal, () => schedule(state, host, abort.signal))).then(
    reason => report(run, `has ended: ${reason}`, "Install a library version into a workspace with /self-improve install <version>."),
    (error: unknown) => abort.signal.aborted
      ? `The self-improve run ${run.root} was stopped: its running trials were ended and count as abandoned. /self-improve resume continues it from what is finished.`
      : report(run, `stopped on an error: ${message(error)}`, "/self-improve resume continues it."),
  ).catch((error: unknown) => `The self-improve run ${run.root} ended, and its state could not be read: ${message(error)}`).finally(() => {
    state.stop()
    scope.closed = true
    if (scheduled === state) scheduled = undefined
  })
  scheduled = state
  if (!exit.watched) {
    exit.watched = true
    process.once("exit", () => scheduled?.stop())
  }
  return state
}

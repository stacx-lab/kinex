import { createHash } from "node:crypto"
import path from "node:path"
import { DISTILL_AGENT } from "./agents.ts"
import { openDistillation, scheduled as ordered } from "./distill.ts"
import { alive, openJob, type Job } from "./job.ts"
import { claimFile, distillationsDir, entries, lockDir, readJson, trialsDir, waveScript, wavesDir, writeJson } from "./layout.ts"
import { newestVersion } from "./library.ts"
import { locked, running } from "./lock.ts"
import { renderStatus, scan, settled, solvedTasks, stepLimits, type Status, type TrialInput } from "./records.ts"
import { RERUNS, type Run } from "./run.ts"
import type { Task } from "./sim.ts"

// The scheduler is code: it reads a run's folder and says what is to be done
// now, and it admits the jobs that do it. It starts nothing itself. The session
// that planned the run asks it through improve_next and starts the wave's
// trials and the distillation as background sub-agents; each sub-agent asks to
// be admitted before it does anything, so which tasks run, how often and how
// many at a time holds whatever the session started. When the sub-agents have
// ended the session is told, and asks again. A run belongs to the Kinex
// process, and one is scheduled at a time.

/** What this Kinex schedules: a run, or the plan of one while `run` is absent. */
export interface Scheduled {
  /** What the user asked for. */
  request: string
  /** The command that runs rosbridge, once the session has named it while it plans. */
  rosbridge?: string
  run?: Run
  /** Whether the user has approved that the run goes on with nobody to approve its steps. */
  approved?: boolean
}

let scheduled: Scheduled | undefined
export const current = () => scheduled
export const schedule = (next: Scheduled | undefined) => { scheduled = next }

/** The ids as a run's tasks: every one in the catalog, all on one robot. */
export function checked(ids: readonly string[], catalog: readonly Task[]): string[] {
  const robots = new Map(catalog.map(task => [task.id, task.robot]))
  const unknown = ids.filter(id => !robots.has(id))
  if (unknown.length) throw new Error(`Unknown tasks: ${unknown.join(", ")}; improve_tasks lists the ids`)
  const used = [...new Set(ids.map(id => robots.get(id)))]
  if (used.length !== 1) throw new Error(used.length ? `The tasks use different robots (${used.join(", ")}); a run practises on one` : "A run needs at least one task")
  return [...new Set(ids)].sort()
}

// The order tasks open in when a distiller has not said: by a hash of the id, so
// that a batch is a mix of the catalog and the same on every pass.
const hashed = (task: string) => createHash("sha1").update(task).digest("hex")

/**
 * The tasks of the next wave: every open task still unsolved, and the next batch
 * of tasks not opened yet, in the distiller's order first. A task is open once a
 * trial of it was started. Batches open one a wave, in the sizes given, and the
 * rest together after them; without batches every task opens in the first wave.
 */
export function waveTasks(tasks: readonly string[], opened: ReadonlySet<string>, solved: ReadonlySet<string>, batches: readonly number[] = [], next: readonly string[] = []): string[] {
  const unopened = tasks.filter(task => !opened.has(task)).sort((a, b) => hashed(a).localeCompare(hashed(b)))
  const order = [...next.filter(task => unopened.includes(task)), ...unopened.filter(task => !next.includes(task))]
  let open = 0
  const size = batches.find(size => (open += size) > opened.size) === undefined ? order.length : open - opened.size
  return [...tasks.filter(task => opened.has(task) && !solved.has(task)), ...order.slice(0, size)]
}

/** A wave as it was opened: its tasks and library stay what they were, whatever is published after it. */
export interface Wave { wave: number; library: string; tasks: string[] }
const waveFile = (root: string, wave: number) => path.join(wavesDir(root), `w${String(wave).padStart(3, "0")}.json`)
async function waves(root: string): Promise<Wave[]> {
  const found = await Promise.all((await entries(wavesDir(root))).filter(name => name.endsWith(".json")).map(name => readJson<Wave>(path.join(wavesDir(root), name))))
  return found.filter(wave => wave !== undefined).sort((a, b) => a.wave - b.wave)
}

const unfinished = (root: string, status: Status) => [
  ...status.trials.filter(trial => !trial.status).map(trial => path.join(trialsDir(root), trial.id)),
  ...status.distillations.filter(distillation => !distillation.status).map(distillation => path.join(distillationsDir(root), distillation.id))]

/** The jobs that are being done: those without a result whose process is alive. Any other job without one is abandoned. */
export async function live(root: string, status: Status): Promise<Set<string>> {
  const found = new Set<string>()
  for (const directory of unfinished(root, status)) if (await alive(directory)) found.add(path.basename(directory))
  return found
}

/**
 * Where a wave stands. A task of it is to be tried when it has no trial in the
 * wave yet, or when its last one did not run: a trial that ended with status
 * error, or was abandoned, is a setup problem and not a task failure, so its task
 * is tried again, up to RERUNS times, and a task that still has not run sits
 * the wave out while the others go on (rsi's infraRetries).
 */
export function waveState(wave: Wave, status: Status, live: ReadonlySet<string>) {
  const own = status.trials.filter(trial => trial.wave === wave.wave)
  const judged = (trial: Status["trials"][number]) => trial.status !== undefined && trial.status !== "error"
  const pending = wave.tasks.filter(task => {
    const tried = own.filter(trial => trial.task === task)
    const last = tried.at(-1)
    if (!last) return true
    return !live.has(last.id) && !judged(last) && tried.length <= RERUNS
  })
  return { pending, running: own.filter(trial => live.has(trial.id)).map(trial => trial.id), ran: own.some(judged), failed: own.filter(trial => trial.status === "error") }
}

export type Step =
  /** Tasks of the wave to try now, with this library version unless the session gives another, and the wave's trials still running. */
  | { kind: "trials"; wave: number; library: string; tasks: string[]; running: string[] }
  | { kind: "distill" }
  /** Nothing to start until one of these ends. */
  | { kind: "wait"; running: string[] }
  | { kind: "end"; reason: string; failed?: boolean }

/**
 * The next step, decided from the run's folder alone, so a run that was stopped
 * continues where it is. A wave in progress goes on. Judged trials that no
 * settled distillation was given are distilled; otherwise the next wave opens.
 * A distillation whose session did not end normally settles nothing, so the
 * same trials are distilled again, and one that could not publish leaves the
 * run on the version it has.
 */
async function decide(run: Run): Promise<{ step: Step; status: Status }> {
  const tasks = run.config.tasks ?? []
  for (;;) {
    const status = await scan(run.root)
    const step = (decided: Step) => ({ step: decided, status })
    const jobs = await live(run.root, status)
    const distilling = status.distillations.filter(distillation => jobs.has(distillation.id)).map(distillation => distillation.id)
    if (distilling.length) return step({ kind: "wait", running: distilling })
    const wave = (await waves(run.root)).at(-1)
    if (wave) {
      const { pending, running, ran, failed } = waveState(wave, status, jobs)
      if (pending.length) return step({ kind: "trials", wave: wave.wave, library: wave.library, tasks: pending, running })
      if (running.length) return step({ kind: "wait", running })
      // A wave none of whose trials ran is the setup's failure, and ends the run.
      if (!ran) return step({ kind: "end", failed: true, reason: `no trial of the wave ran: ${failed.map(trial => `${trial.id} (${trial.task}): ${trial.error}`).join("; ") || "its trials were abandoned"}` })
    }
    const solved = solvedTasks(status)
    if (tasks.every(task => solved.has(task))) return step({ kind: "end", reason: "every task is solved" })
    const rounds = settled(status.distillations)
    if (rounds.length >= run.config.rounds) return step({ kind: "end", reason: "its rounds are done" })
    const given = (distillations: typeof rounds) => new Set(distillations.flatMap(distillation => distillation.trials))
    const distilled = given(rounds)
    // A trial that did not run is not evidence: it waits for no distillation.
    if (status.trials.some(trial => trial.status && trial.status !== "error" && !distilled.has(trial.id))) return step({ kind: "distill" })
    const opened = new Set(status.trials.map(trial => trial.task))
    // A round that neither solved a task nor published leaves the same tasks the same library: only tasks not opened yet would be new.
    const last = rounds.at(-1)
    const before = given(rounds.slice(0, -1))
    if (last && !last.version && tasks.every(task => opened.has(task)) && !status.trials.some(trial => trial.success && last.trials.includes(trial.id) && !before.has(trial.id)))
      return step({ kind: "end", reason: "the last round neither solved a task nor published a library version" })
    const opening: Wave = { wave: (wave?.wave ?? 0) + 1, library: await newestVersion(run.root), tasks: waveTasks(tasks, opened, solved, run.config.batches, await ordered(run.root)) }
    if (!opening.tasks.length) return step({ kind: "end", reason: "no task is left to try" })
    await writeJson(waveFile(run.root, opening.wave), opening)
  }
}

// The scheduler and every job are processes of their own, so each reads the run's folder while it alone holds the run's lock.
const alone = <T>(run: Run, work: () => Promise<T>, signal?: AbortSignal) => locked(lockDir(run.root), work, signal)

/** The next step of the run. It starts nothing and opens no job: the session starts the sub-agents, and each is admitted when it asks. */
export const next = (run: Run): Promise<Step> => alone(run, async () => (await decide(run)).step)

/** What a call may say of the trial it starts: the task, and the library version the worker is given. */
export interface TrialRequest { task: string; library?: string }

/** Why a job a call asked for is not done; the session that asked is told, and asks improve_next. */
export class Refused extends Error {}

const standing = (step: Step) => step.kind === "trials" ? `wave ${step.wave} has ${step.tasks.join(", ")} to try`
  : step.kind === "distill" ? "the wave is to be distilled"
  : step.kind === "wait" ? `${step.running.join(", ")} ${step.running.length === 1 ? "is" : "are"} still running`
  : `the run has ended: ${step.reason}`

/**
 * Opens the job a sub-agent asks for, when the scheduler has it to do. Which tasks
 * are tried, how often and how many at a time is decided here, whatever the session
 * started; what a call may choose, a trial's library version, is checked here too.
 * A trial waits while as many run as the plan allows.
 */
export async function admit(run: Run, request: TrialRequest | "distill", signal?: AbortSignal): Promise<Job> {
  for (;;) {
    const job = await alone(run, async () => {
      const { step, status } = await decide(run)
      if (request === "distill") {
        if (step.kind !== "distill") throw new Refused(`No distillation is to be started: ${standing(step)}`)
        return openDistillation(run, status)
      }
      if (step.kind !== "trials" || !step.tasks.includes(request.task)) throw new Refused(`${request.task} is not to be tried now: ${standing(step)}`)
      const library = request.library ?? step.library
      if (!status.versions.includes(library)) throw new Refused(`No library version ${library}; the run has ${status.versions.join(", ")}`)
      if (step.running.length >= run.config.parallel) return undefined
      const limit = stepLimits(status).get(request.task)
      const input: TrialInput = { wave: step.wave, task: request.task, robot: run.config.robot ?? "", library,
        ...(run.config.seed === undefined ? {} : { seed: run.config.seed }), timeoutS: run.config.trialTimeoutS, ...(limit ? { limit } : {}) }
      return openJob(trialsDir(run.root), "t", input)
    }, signal)
    if (job) return job
    await new Promise(resolve => setTimeout(resolve, 1000))
    signal?.throwIfAborted()
  }
}

// A workflow of pi-subagents can pass a list of at most this many tasks.
const CALL_TASKS = 50
const literal = (value: unknown) => JSON.stringify(value)

/** A step as the session reads it: the calls that start it, and what to do when it has ended. */
export async function describe(run: Run, step: Step): Promise<string> {
  const name = path.basename(run.root)
  const after = "When you are told that it has ended, call improve_next again; where no such notice comes, call bg_wait first. Do not attempt the tasks yourself, and start nothing improve_next did not give."
  if (step.kind === "trials") {
    const calls = Array.from({ length: Math.ceil(step.tasks.length / CALL_TASKS) }, (_, index) => step.tasks.slice(index * CALL_TASKS, (index + 1) * CALL_TASKS))
      .map(tasks => `subagent({ workflow: ${literal(waveScript(run.root))}, args: { run: ${literal(name)}, library: ${literal(step.library)}, tasks: ${literal(tasks)} }, globalConcurrencyLimit: ${run.config.parallel}, async: true })`)
    const versions = (await scan(run.root)).versions
    return [
      `Wave ${step.wave}: ${step.tasks.length} ${step.tasks.length === 1 ? "task" : "tasks"} to try, ${run.config.parallel} at a time, each a trial in a background sub-agent. Start ${calls.length === 1 ? "them with this call" : "them with these calls"}, unless you did a moment ago:`,
      ...calls,
      `${step.running.length ? `Still running: ${step.running.join(", ")}. ` : ""}library is the version the workers are given: ${step.library} is the newest${versions.length > 1 ? `, and it may be another of ${versions.join(", ")}` : ""}. Nothing else in the call is yours to change. ${after}`,
    ].join("\n")
  }
  if (step.kind === "distill") return [
    "The wave is done. Start its distillation now, as a background sub-agent, unless you did a moment ago:",
    `subagent({ agent: "${DISTILL_AGENT}", task: "run=${name}" })`,
    `It turns the trial records into the next library version. ${after}`,
  ].join("\n")
  if (step.kind === "wait") return `Nothing to start: ${step.running.join(", ")} ${step.running.length === 1 ? "is" : "are"} still running. ${after}`
  const how = step.failed ? `stopped on an error: ${step.reason}` : `has ended: ${step.reason}`
  const then = step.failed ? "/self-improve resume continues it." : "Install a library version into a workspace with /self-improve install <version>."
  return `The self-improve run ${run.root} ${how}.\n\n${renderStatus(run.root, await scan(run.root), () => false)}\n\n${then}\nTell the user how the run ended.`
}

/** Ends the run's work at once: its jobs' processes are told to stop, and what finished stays on disk. Returns the jobs stopped. */
export async function stop(run: Run): Promise<string[]> {
  const status = await scan(run.root)
  const stopped: string[] = []
  for (const directory of unfinished(run.root, status)) {
    const claimed = await readJson<{ pid?: number }>(claimFile(directory)).catch(() => undefined)
    if (typeof claimed?.pid !== "number" || !running(claimed.pid)) continue
    process.kill(claimed.pid, "SIGTERM")
    stopped.push(path.basename(directory))
  }
  return stopped
}

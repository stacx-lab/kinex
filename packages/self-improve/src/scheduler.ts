import { createHash } from "node:crypto"
import path from "node:path"
import { DISTILL_AGENT, TRIAL_AGENT } from "./agents.ts"
import { openDistillation, scheduled as ordered } from "./distill.ts"
import { jobAt, openJob, standing, type Job } from "./job.ts"
import { claimFile, distillationsDir, entries, readJson, trialsDir, wavesDir, writeJson } from "./layout.ts"
import { newestVersion } from "./library.ts"
import { running } from "./lock.ts"
import { renderStatus, scan, settled, solvedTasks, stepLimits, type Status, type TrialInput } from "./records.ts"
import { RERUNS, type Run } from "./run.ts"
import type { Task } from "./sim.ts"

// The scheduler is code: one function that reads a run's folder and says what
// is to be done now. It starts nothing itself. The session that planned the
// run asks it through improve_next and starts the trials and the distillation
// it names as background sub-agents; when one ends the session is told, and
// asks again. A run belongs to the Kinex process, and one is scheduled at a time.

/** What this Kinex schedules: a run, or the plan of one while `run` is absent. */
export interface Scheduled {
  /** What the user asked for. */
  request: string
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

/** The jobs without a result: those that wait to be started and those that are running. Any other job without one is abandoned. */
export async function live(root: string, status: Status): Promise<{ waiting: Set<string>; running: Set<string> }> {
  const found = { waiting: new Set<string>(), running: new Set<string>() }
  for (const directory of unfinished(root, status)) {
    const where = await standing(directory)
    if (where !== "abandoned") found[where].add(path.basename(directory))
  }
  return found
}

/**
 * Where a wave stands. A task of it is to be started when it has no trial in the
 * wave yet, or when its last one did not run: a trial that ended with status
 * error, or was abandoned, is a setup problem and not a task failure, so its task
 * is started again, up to RERUNS times, and a task that still has not run sits
 * the wave out while the others go on (rsi's infraRetries).
 */
export function waveState(wave: Wave, status: Status, live: { waiting: ReadonlySet<string>; running: ReadonlySet<string> }) {
  const own = status.trials.filter(trial => trial.wave === wave.wave)
  const judged = (trial: Status["trials"][number]) => trial.status !== undefined && trial.status !== "error"
  const pending = wave.tasks.filter(task => {
    const tried = own.filter(trial => trial.task === task)
    const last = tried.at(-1)
    if (!last) return true
    return !live.waiting.has(last.id) && !live.running.has(last.id) && !judged(last) && tried.length <= RERUNS
  })
  const ids = (set: ReadonlySet<string>) => own.filter(trial => set.has(trial.id)).map(trial => trial.id)
  return { pending, waiting: ids(live.waiting), running: ids(live.running), ran: own.some(judged), failed: own.filter(trial => trial.status === "error") }
}

export type Step =
  /** Trials to start now, also those opened earlier that no process has claimed; `left` more of the wave follow as these end. */
  | { kind: "trials"; wave: number; start: Job[]; running: string[]; left: number }
  | { kind: "distill"; job: Job }
  /** Nothing to start until one of these ends. */
  | { kind: "wait"; running: string[] }
  | { kind: "end"; reason: string; failed?: boolean }

/**
 * The next step, decided from the run's folder alone, so a run that was stopped
 * continues where it is. A wave in progress goes on, `parallel` trials at a
 * time. Judged trials that no settled distillation was given are distilled;
 * otherwise the next wave opens. A distillation whose session did not end
 * normally settles nothing, so the same trials are distilled again, and one
 * that could not publish leaves the run on the version it has.
 */
export async function next(run: Run): Promise<Step> {
  const tasks = run.config.tasks ?? []
  for (;;) {
    const status = await scan(run.root)
    const jobs = await live(run.root, status)
    const distilling = status.distillations.filter(distillation => jobs.running.has(distillation.id)).map(distillation => distillation.id)
    if (distilling.length) return { kind: "wait", running: distilling }
    // A job that was opened and never claimed is named again: starting it twice does it once.
    const unstarted = status.distillations.find(distillation => jobs.waiting.has(distillation.id))
    if (unstarted) return { kind: "distill", job: jobAt(path.join(distillationsDir(run.root), unstarted.id)) }
    const wave = (await waves(run.root)).at(-1)
    if (wave) {
      const { pending, waiting, running, ran, failed } = waveState(wave, status, jobs)
      const start = pending.slice(0, Math.max(0, run.config.parallel - running.length - waiting.length))
      if (start.length || waiting.length) {
        const limits = stepLimits(status)
        const named: Job[] = waiting.map(id => jobAt(path.join(trialsDir(run.root), id)))
        for (const task of start) {
          const limit = limits.get(task)
          const input: TrialInput = { wave: wave.wave, task, robot: run.config.robot ?? "", library: wave.library,
            ...(run.config.seed === undefined ? {} : { seed: run.config.seed }), timeoutS: run.config.trialTimeoutS, ...(limit ? { limit } : {}) }
          named.push(await openJob(trialsDir(run.root), "t", input))
        }
        return { kind: "trials", wave: wave.wave, start: named, running, left: pending.length - start.length }
      }
      if (running.length) return { kind: "wait", running }
      // A wave none of whose trials ran is the setup's failure, and ends the run.
      if (!ran) return { kind: "end", failed: true, reason: `no trial of the wave ran: ${failed.map(trial => `${trial.id} (${trial.task}): ${trial.error}`).join("; ") || "its trials were abandoned"}` }
    }
    const solved = solvedTasks(status)
    if (tasks.every(task => solved.has(task))) return { kind: "end", reason: "every task is solved" }
    const rounds = settled(status.distillations)
    if (rounds.length >= run.config.rounds) return { kind: "end", reason: "its rounds are done" }
    const given = (distillations: typeof rounds) => new Set(distillations.flatMap(distillation => distillation.trials))
    const distilled = given(rounds)
    // A trial that did not run is not evidence: it waits for no distillation.
    if (status.trials.some(trial => trial.status && trial.status !== "error" && !distilled.has(trial.id))) return { kind: "distill", job: await openDistillation(run, status) }
    const opened = new Set(status.trials.map(trial => trial.task))
    // A round that neither solved a task nor published leaves the same tasks the same library: only tasks not opened yet would be new.
    const last = rounds.at(-1)
    const before = given(rounds.slice(0, -1))
    if (last && !last.version && tasks.every(task => opened.has(task)) && !status.trials.some(trial => trial.success && last.trials.includes(trial.id) && !before.has(trial.id)))
      return { kind: "end", reason: "the last round neither solved a task nor published a library version" }
    const opening: Wave = { wave: (wave?.wave ?? 0) + 1, library: await newestVersion(run.root), tasks: waveTasks(tasks, opened, solved, run.config.batches, await ordered(run.root)) }
    if (!opening.tasks.length) return { kind: "end", reason: "no task is left to try" }
    await writeJson(waveFile(run.root, opening.wave), opening)
  }
}

const call = (agent: string, job: Job) => `subagent({ agent: "${agent}", task: "${job.id}" })`

/** A step as the session reads it: what to start, and what to do when it has ended. */
export async function describe(run: Run, step: Step): Promise<string> {
  const after = "When you are told that one has ended, call improve_next again; where no such notice comes, call bg_wait first. Do not attempt the tasks yourself, and start nothing improve_next did not name."
  if (step.kind === "trials") return [
    `Wave ${step.wave}: ${step.start.length === 1 ? "start this trial now, as a background sub-agent" : `start these ${step.start.length} trials now, each as a background sub-agent with a call of its own`}, unless you started it a moment ago:`,
    ...step.start.map(job => call(TRIAL_AGENT, job)),
    `${step.running.length ? `Still running: ${step.running.join(", ")}. ` : ""}${step.left ? `${step.left} more of this wave start as these end. ` : ""}${after}`,
  ].join("\n")
  if (step.kind === "distill") return [
    "The wave is done. Start its distillation now, as a background sub-agent, unless you started it a moment ago:", call(DISTILL_AGENT, step.job),
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

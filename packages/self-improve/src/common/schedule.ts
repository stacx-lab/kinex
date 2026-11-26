import path from "node:path"
import { alive, unfinished } from "./job.ts"
import { claimFile, lockDir, readJson } from "./layout.ts"
import { locked, running } from "./lock.ts"

// A strategy's scheduler is code: it reads a run's folder and says what is to be
// done now, and it admits the jobs that do it. It starts nothing itself. The
// session that planned the run asks it what to start and starts its jobs as
// background sub-agents; each asks to be admitted before it does anything. A run
// belongs to the Kinex process that schedules it, and one is scheduled at a time,
// whichever strategy made it.

/** What this Kinex schedules: a run, or the plan of one while `root` is absent. */
export interface Scheduled {
  /** The strategy whose command the user started it with. */
  strategy: string
  /** What the user asked for. */
  request: string
  /** The run's folder, once the plan is approved; its config.json is read again at every step. */
  root?: string
  /** Whether the user has approved that the run goes on with nobody to approve its steps. */
  approved?: boolean
}

let scheduled: Scheduled | undefined
export const current = () => scheduled
export const schedule = (next: Scheduled | undefined) => { scheduled = next }

/** Why a job a call asked for is not done; the session that asked is told, and asks what to start next. */
export class Refused extends Error {}

/** Runs `work` while this process alone holds the run's lock: the scheduler and every job are processes of their own. */
export const alone = <T>(root: string, work: () => Promise<T>, signal?: AbortSignal) => locked(lockDir(root), work, signal)

/** The jobs in `folders` that are being done: those without a result whose process is alive. Any other job without one is abandoned. */
export async function live(folders: readonly string[]): Promise<Set<string>> {
  const found = new Set<string>()
  for (const directory of await unfinished(folders)) if (await alive(directory)) found.add(path.basename(directory))
  return found
}

/** Ends the work in `folders` at once: their jobs' processes are told to stop, and what finished stays on disk. Returns the jobs stopped. */
export async function stopJobs(folders: readonly string[]): Promise<string[]> {
  const stopped: string[] = []
  for (const directory of await unfinished(folders)) {
    const claimed = await readJson<{ pid?: number }>(claimFile(directory)).catch(() => undefined)
    if (typeof claimed?.pid !== "number" || !running(claimed.pid)) continue
    process.kill(claimed.pid, "SIGTERM")
    stopped.push(path.basename(directory))
  }
  return stopped
}

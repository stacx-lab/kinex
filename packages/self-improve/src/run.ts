import { AsyncLocalStorage } from "node:async_hooks"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { configFile, entries, readJson, runsDir, writeJson } from "./layout.ts"
import { createLibrary } from "./library.ts"

export interface Config {
  /** The task selection as the user typed it. */
  selection: string
  rounds: number
  parallel: number
  /** Absent: every trial of a task starts from the simulator's default state for it. */
  seed?: number
  trialTimeoutS: number
  distillTimeoutS: number
  /** Seconds between two worker starts; absent in a run made before the gap existed. */
  startGapS?: number
  /** The command that runs rosbridge. */
  rosbridge: string
}
export interface Run { root: string; config: Config }

// A worker alone loads its devices in 7 to 14 s; five loading at once ran past the devices' 30 s limit.
export const START_GAP_S = 10

export async function createRun(selection: string, options: Pick<Config, "rounds" | "parallel">): Promise<Run> {
  const stamp = new Date().toISOString().replaceAll(/[-:]|\.\d+Z/g, "").replace("T", "-")
  const root = path.join(runsDir(), stamp)
  await mkdir(root, { recursive: true })
  const config: Config = { selection, ...options, trialTimeoutS: 3600, distillTimeoutS: 7200, startGapS: START_GAP_S, rosbridge: process.env.KINEX_ROSBRIDGE ?? "rosbridge" }
  await writeJson(configFile(root), config)
  await createLibrary(root)
  return { root, config }
}

/** The named run, or the newest: run names are their creation times. */
export async function openRun(name?: string): Promise<Run> {
  const selected = name ?? (await entries(runsDir())).filter(entry => !entry.startsWith(".")).at(-1)
  if (!selected) throw new Error("No self-improve run yet; start one with /self-improve <tasks>")
  const root = path.join(runsDir(), selected)
  const config = await readJson<Config>(configFile(root))
  if (!config) throw new Error(`No self-improve run named ${selected}`)
  return { root, config }
}

// The run a session schedules reaches its tools with the call, as core passes a
// signal: nothing the process keeps makes another session a scheduler too.
const scheduled = new AsyncLocalStorage<Run>()
export const activeRun = () => scheduled.getStore()
export const withRun = <T>(run: Run | undefined, call: () => T): T => run ? scheduled.run(run, call) : call()

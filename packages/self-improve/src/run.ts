import { mkdir } from "node:fs/promises"
import path from "node:path"
import { configFile, entries, readJson, runsDir, writeJson } from "./layout.ts"
import { createLibrary } from "./library.ts"

export interface Config {
  /** The request as the user typed it. */
  selection: string
  /** The tasks the request names, once it has been converted; absent until then. */
  tasks?: string[]
  rounds: number
  parallel: number
  /** How many of a distiller's sub-agents run at once; absent in a run made before the value existed. */
  helpers?: number
  /** Absent: every trial of a task starts from the simulator's default state for it. */
  seed?: number
  trialTimeoutS: number
  distillTimeoutS: number
  /** Seconds between two worker starts; absent in a run made before the gap existed. */
  startGapS?: number
  /** The command that runs rosbridge. */
  rosbridge: string
  /** Whether workers run in a bubblewrap sandbox; absent in a run made before it, whose workers keep running without one. */
  sandbox?: boolean
}
export interface Run { root: string; config: Config }

// A worker alone loads its devices in 7 to 14 s; five loading at once ran past the devices' 30 s limit.
export const START_GAP_S = 10
// Sub-agents only read records and call the model, and no trial runs meanwhile: the model account's rate limit is what bounds them.
export const HELPERS = 10

export async function createRun(selection: string, options: Pick<Config, "rounds" | "parallel">): Promise<Run> {
  const stamp = new Date().toISOString().replaceAll(/[-:]|\.\d+Z/g, "").replace("T", "-")
  const root = path.join(runsDir(), stamp)
  await mkdir(root, { recursive: true })
  const config: Config = { selection, ...options, helpers: HELPERS, trialTimeoutS: 3600, distillTimeoutS: 7200, startGapS: START_GAP_S,
    rosbridge: process.env.KINEX_ROSBRIDGE ?? "rosbridge", sandbox: process.env.KINEX_SELF_IMPROVE_SANDBOX !== "off" }
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

/** The request converted: from here on the run schedules these tasks and asks no model which. */
export async function saveTasks(run: Run, tasks: string[]): Promise<void> {
  run.config.tasks = tasks
  await writeJson(configFile(run.root), run.config)
}

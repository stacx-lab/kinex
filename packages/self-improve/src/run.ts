import { mkdir } from "node:fs/promises"
import path from "node:path"
import { configFile, entries, readJson, runsDir, writeJson } from "./layout.ts"
import { createLibrary } from "./library.ts"
import type { Sandbox } from "./sandbox.ts"

export interface Config {
  /** The request as the user typed it. */
  selection: string
  /** The tasks of the approved plan. */
  tasks?: string[]
  /** The robot all of them use. */
  robot?: string
  rounds: number
  parallel: number
  /** The sizes of the first batches of tasks to open, one batch a wave; the rest open together after them. Absent: every task is open from the first wave. */
  batches?: number[]
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
  /** Whether workers run in a sandbox: `true` takes bubblewrap where it can run and Docker where it cannot, a name takes that one. */
  sandbox?: boolean | Sandbox
  /** The image a Docker sandbox starts from; the host's system folders are bound over it. */
  image?: string
  /** The kinex.lib roots that packages composed with core add in the Kinex that made the run: a library must not replace their modules. */
  libRoots?: string[]
}
export interface Run { root: string; config: Config }

// A worker alone loads its devices in 7 to 14 s; five loading at once ran past the devices' 30 s limit.
export const START_GAP_S = 10
// A distiller's sub-agents only read records and call the model, and no trial runs meanwhile: the model account's rate limit is what bounds them.
export const HELPERS = 10

// What is tried again before a run goes on without it, as rsi does (its infraRetries, distill_retries, gate_repairs and repair_hours):
// a trial that did not run, a distillation whose turn did not end normally, and a library that fails the check.
export const RERUNS = 2
export const RETRIES = 2
export const REPAIRS = 2
export const REPAIR_S = 1800

/** The command that runs rosbridge for a new run. */
export const rosbridgeCommand = () => process.env.KINEX_ROSBRIDGE ?? "rosbridge"

/** A new run's settings: the plan and the limits a run starts with. The user approves these, and the run is made from them. */
export function newConfig(selection: string, plan: Pick<Config, "tasks" | "robot" | "rounds" | "parallel" | "batches" | "libRoots" | "sandbox">): Config {
  return { selection, ...plan, helpers: HELPERS, trialTimeoutS: 3600, distillTimeoutS: 7200, startGapS: START_GAP_S, rosbridge: rosbridgeCommand() }
}

export async function createRun(config: Config): Promise<Run> {
  const stamp = new Date().toISOString().replaceAll(/[-:]|\.\d+Z/g, "").replace("T", "-")
  const root = path.join(runsDir(), stamp)
  await mkdir(root, { recursive: true })
  await writeJson(configFile(root), config)
  await createLibrary(root)
  return { root, config }
}

/** The run kept in the folder `root`. */
export async function openRunAt(root: string): Promise<Run> {
  const config = await readJson<Config>(configFile(root))
  if (!config) throw new Error(`No self-improve run in ${root}`)
  return { root, config }
}

/** The named run, or the newest: run names are their creation times. */
export async function openRun(name?: string): Promise<Run> {
  const selected = name ?? (await entries(runsDir())).filter(entry => !entry.startsWith(".")).at(-1)
  if (!selected) throw new Error("No self-improve run yet; start one with /self-improve <what to practise>")
  return openRunAt(path.join(runsDir(), selected)).catch(() => { throw new Error(`No self-improve run named ${selected}`) })
}

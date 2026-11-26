import { createRun as createAny, type Run as AnyRun, type RunConfig, START_GAP_S } from "../../common/run.ts"
import { KINEX_SIM } from "../../common/sim.ts"
import { STRATEGY } from "./names.ts"
import { createLibrary } from "./library.ts"

/** A code-as-skill run's settings: what every run keeps, the plan's tasks and rounds, and the limits of its jobs. */
export interface Config extends RunConfig {
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
  trialTimeoutS: number
  distillTimeoutS: number
}
export type Run = AnyRun<Config>

// A distiller's sub-agents only read records and call the model, and no trial runs meanwhile: the model account's rate limit is what bounds them.
export const HELPERS = 10

// What is tried again before a run goes on without it, as rsi does (its infraRetries, distill_retries, gate_repairs and repair_hours):
// a trial that did not run, a distillation whose turn did not end normally, and a library that fails the check.
export const RERUNS = 2
export const RETRIES = 2
export const REPAIRS = 2
export const REPAIR_S = 1800

/** A new run's settings: the plan and the limits a run starts with. The user approves these, and the run is made from them. */
export function newConfig(selection: string, plan: Pick<Config, "tasks" | "robot" | "rounds" | "parallel" | "batches" | "libRoots" | "seed" | "launch"> & { command?: string }): Config {
  return { selection, helpers: HELPERS, trialTimeoutS: 3600, distillTimeoutS: 7200, startGapS: START_GAP_S, ...plan, command: plan.command ?? KINEX_SIM }
}

/** A new run in the workspace whose Kinex folder is `kinex`, with the empty library L0. */
export async function createRun(kinex: string, config: Config): Promise<Run> {
  const run = await createAny(kinex, STRATEGY, config)
  await createLibrary(run.root)
  return run
}

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
  /** The command that runs rosbridge. */
  rosbridge: string
}
export interface Run { root: string; config: Config }

export async function createRun(selection: string, options: Pick<Config, "rounds" | "parallel">): Promise<Run> {
  const stamp = new Date().toISOString().replaceAll(/[-:]|\.\d+Z/g, "").replace("T", "-")
  const root = path.join(runsDir(), stamp)
  await mkdir(root, { recursive: true })
  const config: Config = { selection, ...options, trialTimeoutS: 3600, distillTimeoutS: 7200, rosbridge: process.env.KINEX_ROSBRIDGE ?? "rosbridge" }
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

// The run this process schedules. It outlives one chat session: /new keeps it.
const state: { active?: Run } = {}
export const activeRun = () => state.active
export const activate = (run: Run) => { state.active = run }

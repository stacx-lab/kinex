import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { configFile, entries, readJson, runsDir, selfImproveDir, writeJson } from "./layout.ts"

/** What every run keeps in its config.json, whichever strategy made it; a strategy's own settings come beside these. */
export interface RunConfig {
  /** The request as the user typed it. */
  selection: string
  /** The command that runs kinex-sim: words, with the environment it needs first as NAME=value. */
  command: string
  /** More options for every `kinex-sim launch` of the run, such as a split or a recording. */
  launch?: string[]
  /** Absent: every episode of a task starts from the simulator's default state for it. */
  seed?: number
  /** Seconds between two worker starts; absent in a run made before the gap existed. */
  startGapS?: number
  /** The image a Docker sandbox starts from, where bubblewrap cannot run; the host's system folders are bound over it. */
  image?: string
  /** The kinex.lib roots that packages composed with core add in the Kinex that made the run: what a run makes must not replace their modules. */
  libRoots?: string[]
}
export interface Run<Config extends RunConfig = RunConfig> { root: string; config: Config }

// A worker alone loads its devices in 7 to 14 s; five loading at once ran past the devices' 30 s limit.
export const START_GAP_S = 10

/** A new run of `strategy` in the workspace whose Kinex folder is `kinex`. */
export async function createRun<Config extends RunConfig>(kinex: string, strategy: string, config: Config): Promise<Run<Config>> {
  const stamp = new Date().toISOString().replaceAll(/[-:]|\.\d+Z/g, "").replace("T", "-")
  const root = path.join(runsDir(kinex, strategy), stamp)
  await mkdir(root, { recursive: true })
  // Runs and the shared Python are large and this machine's own; what a strategy installs in the workspace is the workspace's, and may be kept.
  await writeFile(path.join(selfImproveDir(kinex), ".gitignore"), "*/runs/\npython/\n", { flag: "wx" }).catch((error: unknown) => {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error
  })
  await writeJson(configFile(root), config)
  return { root, config }
}

/** The run kept in the folder `root`. */
export async function openRunAt<Config extends RunConfig>(root: string): Promise<Run<Config>> {
  const config = await readJson<Config>(configFile(root))
  if (!config) throw new Error(`No self-improvement run in ${root}`)
  return { root, config }
}

/**
 * The named run of `strategy` in the workspace whose Kinex folder is `kinex`, or its newest: run names are their
 * creation times. A run of another workspace is named by its folder, as an absolute path.
 */
export async function openRun<Config extends RunConfig>(kinex: string, strategy: string, name?: string): Promise<Run<Config>> {
  if (name && path.isAbsolute(name)) return openRunAt(name)
  const selected = name ?? (await entries(runsDir(kinex, strategy))).filter(entry => !entry.startsWith(".")).at(-1)
  if (!selected) throw new Error(`No ${strategy} run in this workspace yet; start one with /${strategy}`)
  return openRunAt<Config>(path.join(runsDir(kinex, strategy), selected)).catch(() => { throw new Error(`No ${strategy} run named ${selected} in this workspace`) })
}

import path from "node:path"
import os from "node:os"
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises"

// A run belongs to the workspace it was planned in and keeps everything there, in
// the workspace's Kinex folder, under the strategy that made it. Its workers and
// other children run in a sandbox, where nothing of that workspace above their
// own folder has a name, so Kinex discovery, which merges each ancestor's .kinex,
// finds none of it.
//   <workspace>/.kinex/self-improve/
//     .gitignore                        every strategy's runs/ and python/ stay out of version control
//     python/                           the Kinex Python environment this workspace's children share
//     <strategy>/runs/<run>/
//       config.json
//       scheduler.json                  the Kinex that schedules the run now: its children are that Kinex
//       .lock/                          held while the scheduler decides or a job is admitted
//       <jobs>/<id>/{input.json, claim.json, workspace/, record/}
//       ...                             and what else the strategy keeps (strategies/<strategy>/layout.ts)

/** This package's folder in a workspace's Kinex folder. */
export const selfImproveDir = (kinex: string) => path.join(kinex, "self-improve")
export const strategyDir = (kinex: string, strategy: string) => path.join(selfImproveDir(kinex), strategy)
export const runsDir = (kinex: string, strategy: string) => path.join(strategyDir(kinex, strategy), "runs")
/** The self-improve folder of the workspace a run belongs to. */
export const homeOf = (root: string) => path.dirname(path.dirname(path.dirname(root)))
/** The strategy that made the run kept in `root`. */
export const strategyOf = (root: string) => path.basename(path.dirname(path.dirname(root)))
/** The run a job's workspace belongs to. */
export const runOf = (workspace: string) => path.dirname(path.dirname(path.dirname(workspace)))
// The children of a workspace's runs share one Kinex Python environment, whichever strategy made them.
export const pythonDir = (home: string) => path.join(home, "python")
// Kinex's data folder. What only one process of the machine may do at a time, whichever workspace its run belongs to, takes turns here.
export const dataDir = () => process.env.KINEX_DATA_DIR ?? path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "kinex")
export const machineDir = () => path.join(dataDir(), "self-improve")
export const configFile = (root: string) => path.join(root, "config.json")
// Not kinex.json: Kinex reads a kinex.json in every folder above a workspace as its configuration.
export const schedulerFile = (root: string) => path.join(root, "scheduler.json")
// Jobs are processes of their own: each asks the scheduler for its job while it alone holds this.
export const lockDir = (root: string) => path.join(root, ".lock")

// Every job folder has the same entries, whichever kind it is.
export const inputFile = (job: string) => path.join(job, "input.json")
export const claimFile = (job: string) => path.join(job, "claim.json")
export const workspaceDir = (job: string) => path.join(job, "workspace")
export const recordDir = (job: string) => path.join(job, "record")
export const resultFile = (job: string) => path.join(recordDir(job), "result.json")
export const promptFile = (record: string) => path.join(record, "prompt.md")
export const sessionFile = (record: string) => path.join(record, "session.jsonl")
export const outputFile = (record: string) => path.join(record, "output.log")

const missing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT"

export async function entries(directory: string): Promise<string[]> {
  return (await readdir(directory).catch((error: unknown) => { if (missing(error)) return []; throw error })).sort()
}

export async function readJson<T>(file: string): Promise<T | undefined> {
  const text = await readFile(file, "utf8").catch((error: unknown) => { if (missing(error)) return undefined; throw error })
  return text === undefined ? undefined : JSON.parse(text) as T
}

// A file written this way is either absent or complete: its existence can mark a job finished.
export async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(`${file}.tmp`, JSON.stringify(value, null, 2) + "\n")
  await rename(`${file}.tmp`, file)
}

// Creating the directory is the reservation, so two openers never share an id.
export async function reserve(directory: string, prefix: string): Promise<string> {
  await mkdir(directory, { recursive: true })
  for (let next = (await entries(directory)).length + 1; ; next++) {
    const id = `${prefix}${String(next).padStart(3, "0")}`
    const created = await mkdir(path.join(directory, id)).then(() => true, (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") return false
      throw error
    })
    if (created) return id
  }
}

// A session killed at its deadline can end in a half-written line: such a line is skipped, not fatal.
export function parseLine(line: string): unknown {
  try { return JSON.parse(line) } catch { return undefined }
}

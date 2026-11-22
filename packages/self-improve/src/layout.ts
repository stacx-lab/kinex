import path from "node:path"
import os from "node:os"
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises"

// One run keeps everything under its root, outside every workspace: Kinex
// discovery merges each ancestor's .kinex, and the data directory has none.
//   <data>/self-improve/<run>/
//     config.json
//     libraries/L<n>/{manifest.json, payload/{skills,tools,lib,programs,brief.md}, memory/}
//     waves/w<nnn>.json
//     trials/t<nnn>/{input.json, claim.json, workspace/, record/}
//     distillations/d<nnn>/{input.json, claim.json, workspace/, record/}

export const runsDir = () => path.join(
  process.env.KINEX_DATA_DIR ?? path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "kinex"), "self-improve")
// Trial workspaces share one Kinex Python environment; the dot keeps it out of the run names.
export const pythonDir = () => path.join(runsDir(), ".python")
export const configFile = (root: string) => path.join(root, "config.json")
export const librariesDir = (root: string) => path.join(root, "libraries")
export const versionDir = (root: string, version: string) => path.join(librariesDir(root), version)
export const trialsDir = (root: string) => path.join(root, "trials")
export const distillationsDir = (root: string) => path.join(root, "distillations")
export const wavesDir = (root: string) => path.join(root, "waves")

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

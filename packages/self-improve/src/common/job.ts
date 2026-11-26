import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { currentScope } from "@kinex/core/scope"
import { claimFile, entries, inputFile, parseLine, readJson, recordDir, reserve, resultFile, workspaceDir, writeJson } from "./layout.ts"
import { running } from "./lock.ts"

// A job of a run, such as a trial: one folder with an input, a workspace and a record.
export interface Job { id: string; directory: string; workspace: string; record: string }
export type Result = Record<string, unknown> & { status: "done" | "timeout" | "error" }

export const jobAt = (directory: string): Job =>
  ({ id: path.basename(directory), directory, workspace: workspaceDir(directory), record: recordDir(directory) })

// A job is opened by the process that does it, a sub-agent the session started, once the
// scheduler has admitted it (scheduler.ts): the folder is reserved and claimed with that
// process's id, so a job whose process is gone without a result is known to be abandoned.
export async function openJob(directory: string, prefix: string, input: unknown): Promise<Job> {
  const job = jobAt(path.join(directory, await reserve(directory, prefix)))
  await writeFile(claimFile(job.directory), JSON.stringify({ pid: process.pid }) + "\n")
  await writeJson(inputFile(job.directory), input)
  await mkdir(job.workspace)
  await mkdir(job.record)
  return job
}

/** Every job kept in `directory`, as its input and, once it has one, its result say. */
export async function jobViews<View>(directory: string): Promise<View[]> {
  const views: View[] = []
  for (const id of await entries(directory)) {
    const input = await readJson<object>(inputFile(path.join(directory, id)))
    if (input) views.push({ id, ...input, ...await readJson<object>(resultFile(path.join(directory, id))) } as View)
  }
  return views
}

/** The jobs kept in `folders` that have no result: being done, or abandoned. */
export async function unfinished(folders: readonly string[]): Promise<string[]> {
  const found: string[] = []
  for (const folder of folders) for (const id of await entries(folder)) {
    const directory = path.join(folder, id)
    if (await readJson(inputFile(directory)) !== undefined && await readJson(resultFile(directory)) === undefined) found.push(directory)
  }
  return found
}

/** Whether a job without a result is still being done: its process is alive. Otherwise it is abandoned. */
export async function alive(directory: string): Promise<boolean> {
  const claimed = await readJson<{ pid?: number }>(claimFile(directory)).catch(() => undefined)
  return typeof claimed?.pid === "number" && running(claimed.pid)
}

// Tokens and cost as Kinex recorded them in the job's session file and in those of the sub-agents its session started.
export async function usage(record: string) {
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
  // pi-subagents keeps a sub-agent's session below its parent's (session/<run>/), and a copy of its
  // transcript beside it; learned/ holds what a worker kept, which is not a session whatever its name.
  const sessions = (await readdir(record, { recursive: true }).catch(() => []))
    .filter(file => path.basename(file) === "session.jsonl" && file.split(path.sep)[0] !== "learned").map(file => path.join(record, file))
  const lines = (await Promise.all(sessions.map(file => readFile(file, "utf8").catch(() => "")))).flatMap(text => text.split("\n"))
  for (const line of lines) {
    if (!line.includes('"usage"')) continue
    const entry = parseLine(line) as { usage?: Usage; message?: { usage?: Usage } } | undefined
    if (!entry) continue
    const used = entry.usage ?? entry.message?.usage
    if (!used) continue
    total.input += used.input ?? 0
    total.output += used.output ?? 0
    total.cacheRead += used.cacheRead ?? 0
    total.cacheWrite += used.cacheWrite ?? 0
    total.cost += used.cost?.total ?? 0
  }
  return total
}
interface Usage { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } }

// The result is written once; its existence is what marks the job finished. A job
// cut short because its run was stopped or Kinex is quitting gets none: it is abandoned, not failed.
export async function finishJob(job: Job, result: Result): Promise<Result> {
  currentScope().signal?.throwIfAborted()
  const finished = { ...result, usage: await usage(job.record), endedAt: new Date().toISOString() }
  await writeJson(resultFile(job.directory), finished)
  return finished
}

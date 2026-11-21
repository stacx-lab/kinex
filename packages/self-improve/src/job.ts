import { mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import { currentScope } from "@kinex/core/scope"
import { entries, inputFile, parseLine, recordDir, reserve, resultFile, sessionFile, workspaceDir, writeJson } from "./layout.ts"

// A trial or a distillation: one folder with an input, a workspace and a record.
export interface Job { id: string; directory: string; workspace: string; record: string }
export type Result = Record<string, unknown> & { status: "done" | "timeout" | "error" }

export const jobAt = (directory: string): Job =>
  ({ id: path.basename(directory), directory, workspace: workspaceDir(directory), record: recordDir(directory) })

export async function openJob(directory: string, prefix: string, input: unknown): Promise<Job> {
  const job = jobAt(path.join(directory, await reserve(directory, prefix)))
  await writeJson(inputFile(job.directory), input)
  await mkdir(job.workspace)
  await mkdir(job.record)
  return job
}

// Tokens and cost as Kinex recorded them in the job's session file and in those of its helpers.
export async function usage(record: string) {
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
  const helpers = path.join(record, "helpers")
  const sessions = [record, ...(await entries(helpers)).map(name => path.join(helpers, name))].map(sessionFile)
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

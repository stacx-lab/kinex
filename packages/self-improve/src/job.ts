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
// cut short because Kinex is quitting gets none: it is abandoned, not failed.
export async function finishJob(job: Job, result: Result): Promise<Result> {
  currentScope().signal?.throwIfAborted()
  const finished = { ...result, usage: await usage(job.record), endedAt: new Date().toISOString() }
  await writeJson(resultFile(job.directory), finished)
  return finished
}

// Work started by this process and not yet ended. Jobs belong to the process
// that started them, so nothing on disk has to say which of them are alive.
const running = new Map<string, Promise<Result>>()
const ended = new Map<string, Result>()
const lanes = new Map<string, { free: number; queue: (() => void)[] }>()

/** Starts `run` once its lane has a free slot (at most `limit` at a time) and returns at once. */
export function start(id: string, lane: string, limit: number, run: () => Promise<Result>): void {
  if (running.has(id)) throw new Error(`${id} is already running`)
  const slots = lanes.get(lane) ?? { free: limit, queue: [] }
  lanes.set(lane, slots)
  const pending = (async () => {
    if (slots.free > 0) slots.free--
    else await new Promise<void>(resolve => slots.queue.push(resolve))
    try { return await run() }
    catch (error) { return { status: "error" as const, error: error instanceof Error ? error.message : String(error) } }
    finally {
      const next = slots.queue.shift()
      if (next) next()
      else slots.free++
    }
  })()
  running.set(id, pending)
  void pending.then(result => { running.delete(id); ended.set(id, result) })
}

/** Starts a job's runner; a runner that fails still leaves a result, so the job counts as finished. */
export function startJob(job: Job, lane: string, limit: number, run: () => Promise<Result>): void {
  start(job.id, lane, limit, () => run().catch((error: unknown) => finishJob(job, { status: "error", error: error instanceof Error ? error.message : String(error) })))
}

// Work that must not begin at the same moment takes turns: each caller's turn
// comes no sooner than `gapS` after the turn before it in the same lane.
const turns = new Map<string, Promise<void>>()
export function spaced(lane: string, gapS: number): Promise<void> {
  const turn = turns.get(lane) ?? Promise.resolve()
  turns.set(lane, turn.then(() => new Promise<void>(resolve => setTimeout(resolve, gapS * 1000))))
  return turn
}

export const isRunning = (id: string) => running.has(id)
export const runningIDs = () => [...running.keys()]
export const resultOf = (id: string) => ended.get(id)

/** Waits for the named work, all of it or the first to end; the wait can be cancelled or time out, the work cannot. */
export async function wait(ids: readonly string[], mode: "all" | "any", timeoutS: number, signal: AbortSignal): Promise<void> {
  const pending = ids.flatMap(id => running.get(id) ?? [])
  if (!pending.length) return
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutS * 1000)
  const stop = AbortSignal.any([signal, controller.signal])
  const stopped = new Promise<void>(resolve => stop.addEventListener("abort", () => resolve(), { once: true }))
  try { await Promise.race([mode === "all" ? Promise.all(pending) : Promise.race(pending), stopped]) }
  finally { clearTimeout(timer); controller.abort() }
  signal.throwIfAborted()
}

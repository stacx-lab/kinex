import { execFile, spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"

// The simulator seam: list tasks, open one episode of a task for a workspace,
// close it and read the simulator's own verdict. rosbridge is called as the
// command a user runs by hand; it is not imported.
export interface Task { id: string; robot: string; split?: string }
export interface Verdict { success: boolean; steps?: number; worldS?: number; reason?: string; cause?: string; seed?: number }
/** What a worker is told to do, and where it was found: the simulator's own words, or the task's name when it gave none. */
export interface Instruction { text: string; source: "file" | "log" | "task name" }
export interface Sim { run: string; instruction: Instruction; close(): Promise<Verdict> }

const exec = promisify(execFile)

async function rosbridge(command: string, args: string[]): Promise<Record<string, unknown>> {
  const [file = "rosbridge", ...first] = command.trim().split(/\s+/)
  const { stdout, failure } = await exec(file, [...first, ...args, "--json"], { maxBuffer: 64 * 1024 * 1024 })
    .then(result => ({ stdout: result.stdout, failure: undefined }),
      (error: Error & { stdout?: string; stderr?: string }) => ({ stdout: error.stdout ?? "", failure: error }))
  const line = stdout.trim().split("\n").at(-1) ?? ""
  const value: unknown = line.startsWith("{") ? JSON.parse(line) : undefined
  const reported = value && typeof value === "object" && "error" in value ? String(value.error) : undefined
  if (failure || reported || !value) throw new Error(`rosbridge ${args[0]}: ${reported ?? (failure?.stderr?.trim() || failure?.message || "no JSON output")}`)
  return value as Record<string, unknown>
}

/** A pattern against whole task ids, where * matches any characters: libero/libero-spatial-*. */
export const matching = (pattern: string) => new RegExp(`^${pattern.split("*").map(part => part.replaceAll(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`)

export async function listTasks(command: string, simulator?: string): Promise<Task[]> {
  const catalog = await rosbridge(command, ["tasks", "list", ...(simulator ? ["--simulator", simulator] : [])]) as
    { ids?: string[]; robots?: Record<string, string>; splits?: Record<string, string> }
  return (catalog.ids ?? []).map(id => ({ id, robot: catalog.robots?.[id] ?? "", ...(catalog.splits?.[id] ? { split: catalog.splits[id] } : {}) }))
}

// rosbridge starts simulators detached, so one this process opened is stopped
// when the process exits before its trial closed it. Exit is the process's, so
// this list is too; the listener comes with the first simulator, and loading
// Kinex registers none.
const open = new Map<string, string>()
const exit = { watched: false }
function stopAtExit(run: string, command: string) {
  open.set(run, command)
  if (exit.watched) return
  exit.watched = true
  process.once("exit", () => {
    for (const [id, stop] of open) {
      const [file = "rosbridge", ...first] = stop.trim().split(/\s+/)
      spawn(file, [...first, "stop", id], { detached: true, stdio: "ignore" }).unref()
    }
  })
}

// rosbridge does not publish instructions: a simulator that has one leaves it in
// the run's folder for the operator to hand over, each in its own way. One writes
// <simulator>/PROMPT.json; others print a line to the run log when the episode
// starts, tagged with the simulator's name:
//   [robocasa] OpenCabinet seed 101, split target, layout 4, style 4: Open the cabinet doors.
// Of that line only the tag and its first colon are relied on; what a simulator
// puts between them is its own and changes. The source is kept with the text, so
// a worker that was given only the task's name is seen, not guessed.
export async function instruction(log: unknown, task: string): Promise<Instruction> {
  const [simulator = "", name = task] = task.split("/")
  if (typeof log === "string") {
    const prompt = await readFile(path.join(path.dirname(log), simulator, "PROMPT.json"), "utf8")
      .then(text => (parse(text) as { prompt?: unknown } | undefined)?.prompt, () => undefined)
    if (typeof prompt === "string" && prompt.trim()) return { text: prompt.trim(), source: "file" }
    const tag = `[${simulator}] `
    const line = (await readFile(log, "utf8").catch(() => "")).split("\n").find(line => line.includes(tag))
    const text = line?.slice(line.indexOf(tag)).split(": ").slice(1).join(": ").trim()
    if (text) return { text, source: "log" }
  }
  return { text: name.replaceAll(/[-_]/g, " "), source: "task name" }
}
const parse = (text: string): unknown => { try { return JSON.parse(text) } catch { return undefined } }

/** Launches one stepped episode on a ROS domain of its own and exports that episode's workspace onto that domain. */
export async function openSim(command: string, input: { task: string; seed?: number }, workspace: string): Promise<Sim> {
  // setup exports the workspace a launch of the same task and seed serves; without a seed both take the task's default.
  const seed = input.seed === undefined ? [] : ["--seed", String(input.seed)]
  const record = await rosbridge(command, ["launch", input.task, "--execution-mode", "stepped", "--early-stop", "--detach", ...seed])
  const run = String(record.id)
  stopAtExit(run, command)
  const close = async (): Promise<Verdict> => {
    // The outcome of an episode that has not ended is recorded when its run stops.
    await rosbridge(command, ["stop", run]).finally(() => open.delete(run))
    const judged = await rosbridge(command, ["judge", run]) as { episodes?: { success?: boolean; step?: number; time_s?: number; reason?: string; cause?: string; seed?: number }[] }
    const outcome = judged.episodes?.at(-1)
    if (!outcome) throw new Error(`rosbridge judged no episode for run ${run}`)
    return { success: outcome.success === true, steps: outcome.step, worldS: outcome.time_s, reason: outcome.reason, cause: outcome.cause, seed: outcome.seed }
  }
  try {
    await rosbridge(command, ["setup", input.task, ...seed, "--directory", workspace, "--domain-id", String(record.domain_id)])
    return { run, instruction: await instruction(record.log, input.task), close }
  } catch (error) {
    await close().catch(() => {})
    throw error
  }
}

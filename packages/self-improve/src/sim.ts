import { execFile, spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import { promisify } from "node:util"

// The simulator seam: list tasks, open one episode of a task for a workspace,
// close it and read the simulator's own verdict. rosbridge is called as the
// command a user runs by hand; it is not imported.
export interface Task { id: string; robot: string; split?: string }
export interface Verdict { success: boolean; steps?: number; reason?: string; seed?: number }
export interface Sim { run: string; instruction: string; close(): Promise<Verdict> }

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

// rosbridge does not publish instructions; a simulator that has one prints it to the run log when the episode starts.
async function instruction(log: unknown, task: string): Promise<string> {
  const text = typeof log === "string" ? await readFile(log, "utf8").catch(() => "") : ""
  return text.match(/^\[[\w-]+\] .*\bseed -?\d+: (\S.*)$/m)?.[1]?.trim() ?? (task.split("/").at(-1) ?? task).replaceAll(/[-_]/g, " ")
}

/** Launches one stepped episode on a ROS domain of its own and exports the robot's workspace onto that domain. */
export async function openSim(command: string, input: { task: string; robot: string; seed?: number }, workspace: string): Promise<Sim> {
  const record = await rosbridge(command, ["launch", input.task, "--execution-mode", "stepped", "--stop-on-success", "--detach",
    ...(input.seed === undefined ? [] : ["--seed", String(input.seed)])])
  const run = String(record.id)
  stopAtExit(run, command)
  const close = async (): Promise<Verdict> => {
    // The outcome of an episode that has not ended is recorded when its run stops.
    await rosbridge(command, ["stop", run]).finally(() => open.delete(run))
    const judged = await rosbridge(command, ["judge", run]) as { episodes?: { success?: boolean; step?: number; reason?: string; seed?: number }[] }
    const outcome = judged.episodes?.at(-1)
    if (!outcome) throw new Error(`rosbridge judged no episode for run ${run}`)
    return { success: outcome.success === true, steps: outcome.step, reason: outcome.reason, seed: outcome.seed }
  }
  try {
    await rosbridge(command, ["setup", input.robot, "--directory", workspace, "--domain-id", String(record.domain_id)])
    return { run, instruction: await instruction(record.log, input.task), close }
  } catch (error) {
    await close().catch(() => {})
    throw error
  }
}

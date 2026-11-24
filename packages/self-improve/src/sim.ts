import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"

// The simulator seam: list tasks, open one episode of a task for a workspace,
// close it and read the simulator's own verdict. kinex-sim is called as the
// command a user runs by hand; it is not imported.
export interface Task { id: string; robot: string; split?: string }
export interface Verdict { success: boolean; steps?: number; worldS?: number; reason?: string; cause?: string; seed?: number }
/** What a worker is told to do, and where it was found: the simulator's own words, or the task's name when it gave none. */
export interface Instruction { text: string; source: "simulator" | "task name" }
export interface Sim { run: string; instruction: Instruction; close(): Promise<Verdict> }

const exec = promisify(execFile)

/**
 * The command that runs kinex-sim, as a plan gives it: words without quoting, the environment
 * it needs first as NAME=value, then the program and what comes before kinex-sim's own command.
 *   CUDA_VISIBLE_DEVICES=1 /sim/kinex-sim/.venv/bin/kinex-sim
 */
export function commandLine(command: string): { file: string; first: string[]; env: Record<string, string> } {
  const words = command.trim().split(/\s+/).filter(Boolean)
  const set = words.findIndex(word => !/^[A-Za-z_]\w*=/.test(word))
  const [file = "kinex-sim", ...first] = set < 0 ? [] : words.slice(set)
  return { file, first, env: Object.fromEntries(words.slice(0, set < 0 ? words.length : set).map(word => [word.slice(0, word.indexOf("=")), word.slice(word.indexOf("=") + 1)])) }
}

// What every trial's launch is given by the method, and the seed, which the plan has a name for: a plan's own launch options may not set them.
const FIXED = ["--execution-mode", "--early-stop", "--detach", "--domain-id", "--json", "--seed"]
// Options of launch that setup takes too: the workspace it exports is the one that launch serves.
const SHARED = ["--config"]
const named = (option: string, names: readonly string[]) => names.find(name => option === name || option.startsWith(`${name}=`))

/** A plan's launch options, refused where one is the method's to give. */
export function launchOptions(options: readonly string[] = []): string[] {
  const fixed = options.map(option => named(option, FIXED)).find(Boolean)
  if (fixed) throw new Error(`${fixed} is not a launch option of a plan: every trial is stepped, ends where the simulator's check does and has a ROS domain of its own, and the seed is the plan's seed`)
  return [...options]
}

// The shared options among the launch options, each with its value.
function shared(options: readonly string[]): string[] {
  return options.flatMap((option, index) => !named(option, SHARED) ? [] : option.includes("=") ? [option] : [option, ...options.slice(index + 1, index + 2)])
}

async function kinexSim(command: string, args: string[]): Promise<Record<string, unknown>> {
  const { file, first, env } = commandLine(command)
  const { stdout, failure } = await exec(file, [...first, ...args, "--json"], { maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...env } })
    .then(result => ({ stdout: result.stdout, failure: undefined }),
      (error: Error & { stdout?: string; stderr?: string }) => ({ stdout: error.stdout ?? "", failure: error }))
  const line = stdout.trim().split("\n").at(-1) ?? ""
  const value: unknown = line.startsWith("{") ? JSON.parse(line) : undefined
  const reported = value && typeof value === "object" && "error" in value ? String(value.error) : undefined
  if (failure || reported || !value) throw new Error(`kinex-sim ${args[0]}: ${reported ?? (failure?.stderr?.trim() || failure?.message || "no JSON output")}`)
  return value as Record<string, unknown>
}

/** A pattern against whole task ids, where * matches any characters: libero/libero-spatial-*. */
export const matching = (pattern: string) => new RegExp(`^${pattern.split("*").map(part => part.replaceAll(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`)

export async function listTasks(command: string, simulator?: string): Promise<Task[]> {
  const catalog = await kinexSim(command, ["tasks", "list", ...(simulator ? ["--simulator", simulator] : [])]) as
    { ids?: string[]; robots?: Record<string, string>; splits?: Record<string, string> }
  return (catalog.ids ?? []).map(id => ({ id, robot: catalog.robots?.[id] ?? "", ...(catalog.splits?.[id] ? { split: catalog.splits[id] } : {}) }))
}

// kinex-sim starts simulators detached, so one this process opened is stopped
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
      const { file, first, env } = commandLine(stop)
      spawn(file, [...first, "stop", id], { detached: true, stdio: "ignore", env: { ...process.env, ...env } }).unref()
    }
  })
}

// What a worker is told to do is the task description of the launched episode, which
// `kinex-sim describe` reads from the run's log: the instruction upstream's evaluator gives
// its policy, then any further text the simulator states under a name of its own, as
// RoboDojo's detailed instruction. The task and the seed in it are the trial's own. The
// source is kept with the text, so a worker that was given only the task's name is seen,
// not guessed.
export function instruction(description: Record<string, unknown> | undefined, task: string): Instruction {
  const { task: _task, seed: _seed, instruction: stated, ...further } = description ?? {}
  if (typeof stated !== "string" || !stated.trim()) return { text: (task.split("/")[1] ?? task).replaceAll(/[-_]/g, " "), source: "task name" }
  const more = Object.entries(further).filter(([, text]) => typeof text === "string" && text.trim())
    .map(([name, text]) => `${name[0]?.toUpperCase()}${name.slice(1).replaceAll("_", " ")}:\n${String(text).trim()}`)
  return { text: [stated.trim(), ...more].join("\n\n"), source: "simulator" }
}

/** Launches one stepped episode on a ROS domain of its own and exports that episode's workspace onto that domain. */
export async function openSim(command: string, input: { task: string; seed?: number; launch?: readonly string[]; record?: string }, workspace: string): Promise<Sim> {
  // setup exports the workspace a launch of the same task and seed serves; without a seed both take the task's default.
  const seed = input.seed === undefined ? [] : ["--seed", String(input.seed)]
  // The options are the same for every trial of the run; {record} in one is the trial's own record folder.
  const options = launchOptions(input.launch).map(option => input.record ? option.replaceAll("{record}", input.record) : option)
  const record = await kinexSim(command, ["launch", input.task, "--execution-mode", "stepped", "--early-stop", "--detach", ...seed, ...options])
  const run = String(record.id)
  stopAtExit(run, command)
  const close = async (): Promise<Verdict> => {
    // The outcome of an episode that has not ended is recorded when its run stops.
    await kinexSim(command, ["stop", run]).finally(() => open.delete(run))
    const judged = await kinexSim(command, ["judge", run]) as { episodes?: { success?: boolean; step?: number; time_s?: number; reason?: string; cause?: string; seed?: number }[] }
    const outcome = judged.episodes?.at(-1)
    if (!outcome) throw new Error(`kinex-sim judged no episode for run ${run}`)
    return { success: outcome.success === true, steps: outcome.step, worldS: outcome.time_s, reason: outcome.reason, cause: outcome.cause, seed: outcome.seed }
  }
  try {
    await kinexSim(command, ["setup", input.task, ...seed, ...shared(options), "--directory", workspace, "--domain-id", String(record.domain_id)])
    const description = await kinexSim(command, ["describe", "--domain-id", String(record.domain_id)]).catch(() => undefined)
    return { run, instruction: instruction(description, input.task), close }
  } catch (error) {
    await close().catch(() => {})
    throw error
  }
}

import { cp, mkdir, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { distillationsDir, entries, inputFile, readJson, recordDir, resultFile, sessionFile, trialsDir, versionDir, workspaceDir } from "./layout.ts"
import { keep } from "./learned.ts"
import { versions } from "./library.ts"
import type { Config } from "./run.ts"
import { writeTranscript } from "./transcript.ts"

export interface TrialInput { task: string; robot: string; library: string; seed?: number; timeoutS: number }
export interface DistillInput { base: string; trials: string[]; fresh: string[]; timeoutS: number }
interface Usage { input: number; output: number; cost: number }

export interface TrialView extends TrialInput {
  id: string
  /** Absent while the trial has no result: running in the process that started it, or abandoned. */
  status?: "done" | "timeout" | "error"
  success?: boolean
  steps?: number
  reason?: string
  instruction?: string
  wallS?: number
  error?: string
  /** What went wrong outside the task in a trial that was still judged. */
  note?: string
  usage?: Usage
}
export interface DistillationView extends DistillInput {
  id: string
  status?: "done" | "timeout" | "error"
  version?: string
  problems?: string[]
  wallS?: number
  error?: string
  usage?: Usage
}
export interface Status {
  versions: string[]
  trials: TrialView[]
  distillations: DistillationView[]
  /** Finished trials that no distillation which published a version was given. */
  fresh: string[]
}

async function jobs<View>(directory: string): Promise<View[]> {
  const views: View[] = []
  for (const id of await entries(directory)) {
    const input = await readJson<object>(inputFile(path.join(directory, id)))
    if (input) views.push({ id, ...input, ...await readJson<object>(resultFile(path.join(directory, id))) } as View)
  }
  return views
}

/** The state of a run, read from its folders; nothing else records it. */
export async function scan(root: string): Promise<Status> {
  const trials = await jobs<TrialView>(trialsDir(root))
  const distillations = await jobs<DistillationView>(distillationsDir(root))
  const seen = new Set(distillations.filter(distillation => distillation.version).flatMap(distillation => distillation.trials))
  return { versions: await versions(root), trials, distillations, fresh: trials.filter(trial => trial.status && !seen.has(trial.id)).map(trial => trial.id) }
}

export const solvedTasks = (status: Status) => new Set(status.trials.filter(trial => trial.success).map(trial => trial.task))
const taskIDs = (status: Status) => [...new Set(status.trials.map(trial => trial.task))].sort()
const dollars = (views: { usage?: Usage }[]) => `$${views.reduce((sum, view) => sum + (view.usage?.cost ?? 0), 0).toFixed(2)}`

const outcome = (view: { status?: string }, running: boolean) => view.status ?? (running ? "running" : "abandoned")

export function describeTrial(trial: TrialView, running: boolean): string {
  const verdict = trial.status === undefined || trial.status === "error" ? outcome(trial, running) : `${trial.success ? "success" : "failure"}${trial.status === "timeout" ? " (timeout)" : ""}`
  return [trial.id, trial.task, trial.library, verdict, trial.reason, trial.steps === undefined ? undefined : `${trial.steps} steps`,
    trial.wallS === undefined ? undefined : `${trial.wallS} s`, trial.usage ? dollars([trial]) : undefined, trial.error, trial.note].filter(Boolean).join(", ")
}

export function describeDistillation(distillation: DistillationView, running: boolean): string {
  const result = distillation.version ? `published ${distillation.version}` : distillation.status === undefined ? outcome(distillation, running)
    : `published nothing (${distillation.error ?? (distillation.problems?.length ? `check failed: ${distillation.problems.join("; ")}` : distillation.status)})`
  return `${distillation.id}, base ${distillation.base}, ${distillation.trials.length} trials (${distillation.fresh.length} new), ${result}`
}

/** What the scheduler and the user read: solved tasks per version first, then every job in one line. */
export function renderStatus(root: string, status: Status, running: (id: string) => boolean): string {
  const solved = solvedTasks(status)
  const tasks = taskIDs(status)
  const cell = (task: string, version: string) => {
    const tried = status.trials.filter(trial => trial.task === task && trial.library === version && trial.status)
    return tried.length ? `${tried.filter(trial => trial.success).length}/${tried.length}` : "-"
  }
  return [
    `Run: ${root}`,
    `Library versions: ${status.versions.join(", ")} (newest ${status.versions.at(-1)}; ${root}/libraries)`,
    "",
    `Tasks: ${solved.size}/${tasks.length} solved. Successes/trials per library version:`,
    ...tasks.map(task => `- ${task} [${solved.has(task) ? "solved" : "UNSOLVED"}] ${status.versions.map(version => `${version} ${cell(task, version)}`).join(", ")}`),
    "",
    `Trials (${root}/trials/<id>/record):`,
    ...status.trials.map(trial => `- ${describeTrial(trial, running(trial.id))}`),
    "",
    `Distillations (rounds done: ${status.distillations.filter(distillation => distillation.status).length}):`,
    ...status.distillations.map(distillation => `- ${describeDistillation(distillation, running(distillation.id))}`),
    "",
    `Finished trials not yet distilled: ${status.fresh.join(", ") || "none"}`,
    `Cost: trials ${dollars(status.trials)}, distillations ${dollars(status.distillations)}`,
  ].join("\n")
}

/**
 * A finished trial's record as a distiller reads it, written once beside the
 * session file: what the worker kept beyond the library it was shipped
 * (learned/, learned.md) and its transcript in brief and in full (summary.md,
 * history.md, history.json, images/).
 */
export async function writeRecord(root: string, trial: TrialView): Promise<void> {
  const directory = path.join(trialsDir(root), trial.id)
  await keep(workspaceDir(directory), versionDir(root, trial.library), recordDir(directory))
  await writeTranscript(recordDir(directory), trial)
}

/** Trials to distillation: every record copied into the distiller's own folder, with the index files its prompt names. */
export async function collect(root: string, config: Config, input: DistillInput, directory: string): Promise<TrialView[]> {
  const status = await scan(root)
  const trials = status.trials.filter(trial => input.trials.includes(trial.id))
  const solved = solvedTasks({ ...status, trials })
  const index: string[] = []
  await mkdir(directory, { recursive: true })
  for (const trial of trials) {
    const record = recordDir(path.join(trialsDir(root), trial.id))
    // A trial that ended before records were written this way gets its record now.
    if (!(await stat(path.join(record, "summary.md")).then(() => true, () => false))) await writeRecord(root, trial)
    // Everything but the raw session, which holds every image inline: history.json has its text.
    await cp(record, path.join(directory, trial.id), { recursive: true, filter: source => source !== sessionFile(record) })
    index.push(JSON.stringify({ trial: trial.id, task: trial.task, library: trial.library, status: trial.status, success: trial.success === true,
      reason: trial.reason, steps: trial.steps, wallS: trial.wallS, cost: trial.usage?.cost, note: trial.note, new: input.fresh.includes(trial.id) }))
  }
  await writeFile(path.join(directory, "INDEX.jsonl"), index.join("\n") + "\n")
  const tasks = [...new Set(trials.map(trial => trial.task))].sort()
  await writeFile(path.join(directory, "TASKS.md"), [
    "# Every task: goal, status, trials", "",
    `${tasks.length} tasks: ${solved.size} solved, ${tasks.length - solved.size} unsolved. Per library version: successful trials / trials, then the trials.`, "",
    ...tasks.flatMap(task => {
      const own = trials.filter(trial => trial.task === task)
      return [`## ${task} [${solved.has(task) ? "solved" : "UNSOLVED"}]`, `goal: ${own.find(trial => trial.instruction)?.instruction ?? "(not stated)"}`, "",
        ...status.versions.filter(version => own.some(trial => trial.library === version)).map(version => {
          const shipped = own.filter(trial => trial.library === version)
          return `- ${version}: ${shipped.filter(trial => trial.success).length}/${shipped.length}; ${shipped.map(trial => `${trial.id}[${trial.success ? "success" : trial.status === "done" ? "failure" : trial.status}]`).join(" ")}`
        }), ""]
    }),
  ].join("\n"))
  await writeFile(path.join(directory, "PROTOCOL.md"), `# How the trials in records/ were run

- A trial is one episode of one task: a fresh simulator episode and a fresh sub-agent in a fresh workspace, with at most
  ${config.trialTimeoutS} s of wall time. The simulation advances only while the sub-agent waits on it; the episode ends at the task's
  first success or at the simulator's step limit for the task, if it has one.
- ${config.seed === undefined ? "Every trial of a task starts from the same state: the simulator's default state for that task." : `Every trial of a task starts from the same state (seed ${config.seed}).`}
- The simulator's own success check decides the outcome (result.json: success, steps, reason). status \`timeout\` means the
  wall time ran out; status \`error\` means the trial itself failed to run and says nothing about the task. A \`note\`
  records a failure outside the task (a device that loaded late, say) in a trial that was still judged.
- Every trial shipped one library version (INDEX.jsonl); L0 is the empty library.
- A task counts as solved once any of its trials succeeded.
- The \`new\` flags in INDEX.jsonl mark the trials no published library has incorporated yet.
- Sub-agents were told to keep reusable functions in \`.kinex/lib/\` (imported as \`kinex.lib.<module>\`), whole-task programs in
  \`.kinex/programs/\`, skills in \`.kinex/skills/\` and notes in \`.kinex/memos/\`, improved in place; what each kept beyond the
  library it was shipped is in its learned.md and learned/.
- Sub-agents were kept to their workspace by instruction only, with the network open.
`)
  return trials
}

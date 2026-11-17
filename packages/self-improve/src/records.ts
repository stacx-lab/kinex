import { cp, mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { distillationsDir, entries, parseLine, inputFile, outputFile, promptFile, readJson, recordDir, resultFile, sessionFile, trialsDir } from "./layout.ts"
import { versions } from "./library.ts"
import type { Config } from "./run.ts"

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
    trial.wallS === undefined ? undefined : `${trial.wallS} s`, trial.usage ? dollars([trial]) : undefined, trial.error].filter(Boolean).join(", ")
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

const INPUT_CHARS = 1200
const OUTPUT_CHARS = 2000
const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max)}\n…(${text.length - max} more characters)` : text

interface Block { type: string; text?: string; name?: string; id?: string; arguments?: unknown; data?: string; mimeType?: string }
interface Message { role: string; content?: string | Block[]; toolCallId?: string; isError?: boolean }

/**
 * A transcript as a distiller reads it: one Markdown file with every turn and
 * every tool call (input and output, bounded per call), and the images the
 * calls returned saved beside it. Rendered from the session file Kinex wrote,
 * which holds the images inline and is too large to read raw.
 */
export async function renderHistory(session: string, directory: string): Promise<void> {
  const lines: string[] = []
  const calls = new Map<string, number>()
  let images = 0
  for (const line of (await readFile(session, "utf8").catch(() => "")).split("\n")) {
    if (!line.trim()) continue
    const entry = parseLine(line) as { type?: string; message?: Message } | undefined
    const message = entry?.type === "message" ? entry.message : undefined
    if (!message || message.role === "system") continue
    const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content ?? []
    const call = message.role === "toolResult" ? calls.get(message.toolCallId ?? "") : undefined
    for (const block of blocks) {
      if (block.type === "text" && block.text?.trim()) {
        lines.push(message.role === "toolResult" ? `result of call ${call}${message.isError ? " (error)" : ""}:\n\n\`\`\`\n${clip(block.text, OUTPUT_CHARS)}\n\`\`\`\n`
          : `## ${message.role}\n\n${block.text.trim()}\n`)
      } else if (block.type === "toolCall") {
        calls.set(block.id ?? "", calls.size + 1)
        lines.push(`### call ${calls.size}: ${block.name}\n\n\`\`\`json\n${clip(JSON.stringify(block.arguments), INPUT_CHARS)}\n\`\`\`\n`)
      } else if (block.type === "image" && block.data) {
        const name = `${String(++images).padStart(3, "0")}.${block.mimeType?.split("/")[1] ?? "png"}`
        await mkdir(path.join(directory, "images"), { recursive: true })
        await writeFile(path.join(directory, "images", name), Buffer.from(block.data, "base64"))
        lines.push(`![${call ? `call ${call}` : message.role}](images/${name})\n`)
      }
    }
  }
  await writeFile(path.join(directory, "history.md"), lines.join("\n"))
}

/** Trials to distillation: every record copied into the distiller's own folder, with the index files its prompt names. */
export async function collect(root: string, config: Config, input: DistillInput, directory: string): Promise<TrialView[]> {
  const status = await scan(root)
  const trials = status.trials.filter(trial => input.trials.includes(trial.id))
  const solved = solvedTasks({ ...status, trials })
  const index: string[] = []
  for (const trial of trials) {
    const record = recordDir(path.join(trialsDir(root), trial.id))
    const copy = path.join(directory, trial.id)
    await mkdir(copy, { recursive: true })
    for (const file of [promptFile(record), outputFile(record), resultFile(path.dirname(record))]) await cp(file, path.join(copy, path.basename(file))).catch(() => {})
    await renderHistory(sessionFile(record), copy)
    index.push(JSON.stringify({ trial: trial.id, task: trial.task, library: trial.library, status: trial.status, success: trial.success === true,
      reason: trial.reason, steps: trial.steps, wallS: trial.wallS, cost: trial.usage?.cost, new: input.fresh.includes(trial.id) }))
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
  wall time ran out; status \`error\` means the trial itself failed to run and says nothing about the task.
- Every trial shipped one library version (INDEX.jsonl); L0 is the empty library.
- A task counts as solved once any of its trials succeeded.
- The \`new\` flags in INDEX.jsonl mark the trials no published library has incorporated yet.
- Sub-agents were kept to their workspace by instruction only, with the network open.
`)
  return trials
}

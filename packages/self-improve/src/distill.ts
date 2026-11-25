import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Assets } from "@kinex/core/installation/assets"
import { finishJob, openJob, type Job, type Result } from "./job.ts"
import { distillationsDir, homeOf, parseLine, pythonDir, readJson, trialsDir, versionDir, workspaceDir } from "./layout.ts"
import { check, newestVersion, publish } from "./library.ts"
import { collect, type DistillInput, type Status } from "./records.ts"
import { HELPERS, REPAIRS, REPAIR_S, type Run } from "./run.ts"
import { sandboxOf } from "./sandbox.ts"
import { runSession, type SessionExit } from "./session.ts"
import FRAME from "./distill-frame.txt"
import REPAIR from "./distill-repair.txt"
import RULES from "./distill-rules.txt"
import SCHEDULE from "./distill-schedule.txt"
import REFERENCE from "./reference.txt"

// A distillation is a session of its own in a folder of its own: trial
// records and the base library in, a checked candidate out. The frame and the
// rules are rsi's distill-lean prompts, edited only where this package differs
// from rsi: one episode per trial, trials in waves, the folder names, the check
// and sub-agents as tools, one library with task skills, code as kinex.lib
// modules rather than a skill's body.
export const candidateDir = (workspace: string) => path.join(workspace, "library")

// What a distiller may know of a worker's world, as rsi gives its principal:
// Kinex's own reference, the Python package a worker's code imports with the
// builtin kinex.lib modules as examples, and the robot workspace a worker starts
// in, whose device profiles name every operation. A library's code is written and
// tested against these; all of it is what a worker has itself.
export async function reference(directory: string, rig: string | undefined) {
  const source = (file: string) => path.basename(file) !== "__pycache__"
  await mkdir(directory, { recursive: true })
  await cp(fileURLToPath(new URL("../README.md", import.meta.resolve("@kinex/core"))), path.join(directory, "kinex-core.md"))
  await cp(Assets.python("kinex"), path.join(directory, "python-kinex"), { recursive: true, filter: source })
  if (rig) for (const part of ["workspace.yaml", "devices"]) await cp(path.join(rig, part), path.join(directory, "workspace", part), { recursive: true, filter: source })
  await writeFile(path.join(directory, "INDEX.md"), REFERENCE)
}

// The Kinex folder kinex-sim exported into a trial's workspace. Every trial of a run uses one robot, so the newest stands for all.
async function rigOf(root: string, trials: readonly string[]): Promise<string | undefined> {
  for (const trial of trials.toReversed()) {
    const kinex = path.join(workspaceDir(path.join(trialsDir(root), trial)), ".kinex")
    if (await stat(path.join(kinex, "devices")).then(() => true, () => false)) return kinex
  }
  return undefined
}

/** A distillation as its turns see it; `python` is the trials' environment, which the check compiles code with. */
export interface Distillation { job: Job; input: DistillInput; prompt: string; deadline: number; python: string }

/** Opens the distillation of every finished trial, from the newest library. */
export async function openDistillation(run: Run, status: Status): Promise<Job> {
  const input: DistillInput = { base: await newestVersion(run.root), trials: status.trials.filter(trial => trial.status).map(trial => trial.id), fresh: status.fresh, timeoutS: run.config.distillTimeoutS }
  return openJob(distillationsDir(run.root), "d", input)
}

/** The folder a distiller works in and the prompt it is given: every finished trial's record, the reference, and the newest library as its candidate. */
export async function prepareDistillation(run: Run, job: Job, input: DistillInput): Promise<Distillation> {
  const trials = await collect(run.root, run.config, input, path.join(job.workspace, "records"))
  await reference(path.join(job.workspace, "reference"), await rigOf(run.root, input.trials))
  await mkdir(path.join(job.workspace, "notes"))
  // The distiller's own Kinex folder: without one, Kinex would take the nearest above it, the workspace's the run belongs to.
  await mkdir(path.join(job.workspace, ".kinex"))
  await cp(versionDir(run.root, input.base), candidateDir(job.workspace), { recursive: true })
  const deadline = Date.now() + input.timeoutS * 1000
  const goals = new Map(trials.map(trial => [trial.task, trial.instruction ?? ""]))
  // A task no batch has opened yet has no trial: the distiller is asked to order those.
  const unopened = (run.config.tasks ?? []).filter(task => !goals.has(task))
  for (const task of unopened) goals.set(task, "(not opened yet)")
  const fill: Record<string, string> = {
    WORKER_MODEL: "Kinex, the agent and model you are", WORKER_TIMEOUT: String(run.config.trialTimeoutS), SESSION: job.id,
    DEADLINE: new Date(deadline).toISOString(), HOURS: (input.timeoutS / 3600).toFixed(1),
    TASKS: [...goals].sort().map(([task, goal]) => `- ${task}: ${goal}`).join("\n"), HELPERS: String(run.config.helpers ?? HELPERS),
    SCHEDULE: unopened.length ? SCHEDULE.trim() : "",
  }
  const prompt = `${FRAME}\n${RULES}`.replaceAll(/\[\[(\w+)\]\]/g, (_, name: string) => fill[name] ?? "").replaceAll(/\n{3,}/g, "\n\n")
  return { job, input, prompt, deadline, python: pythonDir(homeOf(run.root)) }
}

type Exit = Pick<SessionExit, "status"> & { error?: string }

/**
 * The distiller's session and, while its candidate fails the check, up to REPAIRS
 * short turns of the same session that are shown what the check found: a library
 * with a fault is mended by the session that wrote it, not dropped for the
 * version before (rsi's gate repair). Returns how the last turn ended.
 */
export async function distillTurns(distillation: Distillation, turn: (prompt: string, deadline: number) => Promise<Exit>): Promise<Exit & { repairs: number }> {
  let exit = await turn(distillation.prompt, distillation.deadline)
  let repairs = 0
  for (; exit.status === "done" && repairs < REPAIRS; repairs++) {
    const problems = await check(candidateDir(distillation.job.workspace), distillation.python)
    if (!problems.length) break
    // Sub-agents of a repair turn end with it.
    distillation.deadline = Date.now() + REPAIR_S * 1000
    const fill: Record<string, string> = { PROBLEMS: problems.join("\n"), DEADLINE: new Date(distillation.deadline).toISOString() }
    exit = await turn(REPAIR.trim().replaceAll(/\[\[(\w+)\]\]/g, (_, name: string) => fill[name] ?? ""), distillation.deadline)
  }
  return { ...exit, repairs }
}

// The order the distiller that made the newest version asked for the tasks not
// opened yet, as it left it in schedule.json; a file that is absent or not of
// that form orders nothing.
export async function scheduled(root: string): Promise<string[]> {
  const source = (await readJson<{ source?: string }>(path.join(versionDir(root, await newestVersion(root)), "manifest.json")))?.source
  if (!source) return []
  const text = await readFile(path.join(workspaceDir(path.join(distillationsDir(root), source)), "schedule.json"), "utf8").catch(() => "")
  const next = (parseLine(text) as { next?: unknown } | undefined)?.next
  return Array.isArray(next) ? next.filter(task => typeof task === "string") : []
}

/** Candidate to version, when the distiller's session ended normally and the check passes; an unfinished one may leave a half-written library. */
export async function finishDistillation(run: Run, { job, input, python }: Distillation, session: Pick<SessionExit, "status" | "wallS"> & { error?: string; repairs?: number }): Promise<Result> {
  const outcome = session.status === "done" ? await publish(run.root, candidateDir(job.workspace), { parent: input.base, source: job.id }, python) : {}
  return finishJob(job, { ...session, ...outcome })
}

// One distillation: a headless distiller in the distillation's own folder, in a
// sandbox as a worker is, then while the check finds problems a repair turn of
// the same session. The distiller's sub-agents are its own and run in its
// sandbox. Only a session that ended normally can publish.
export async function runDistillation(run: Run, job: Job, input: DistillInput, signal: AbortSignal): Promise<Result> {
  const distillation = await prepareDistillation(run, job, input)
  const { python } = distillation
  const confinement = { sandbox: await sandboxOf({ image: run.config.image, python }), image: run.config.image, python }
  const started = Date.now()
  let turns = 0
  const turn = async (prompt: string, deadline: number): Promise<Exit> => {
    const exit = await runSession("distiller", job.workspace, job.record, prompt, deadline, { ...confinement, signal, resume: turns++ > 0 })
    return exit.status === "error" ? { status: "error", error: `the distiller exited ${exit.exitCode}; see output.log` } : { status: exit.status }
  }
  const exit = await distillTurns(distillation, turn)
  signal.throwIfAborted()
  return finishDistillation(run, distillation, { ...exit, wallS: Math.round((Date.now() - started) / 1000) })
}

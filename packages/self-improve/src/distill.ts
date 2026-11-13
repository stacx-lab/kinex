import { cp, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { finishJob, type Job, type Result } from "./job.ts"
import { versionDir } from "./layout.ts"
import { publish } from "./library.ts"
import { collect, type DistillInput } from "./records.ts"
import type { Run } from "./run.ts"
import { runSession } from "./session.ts"
import FRAME from "./distill-frame.txt"
import RULES from "./distill-rules.txt"
import REFERENCE from "./reference.txt"

// The frame and the rules are rsi's distill-lean prompts, edited only where this
// package differs from rsi: one episode per trial, trials in waves, the folder
// names, the check and sub-agents as tools, one library with task skills, no container.
export const candidateDir = (workspace: string) => path.join(workspace, "library")

// What a worker can do and what a tool directory must contain: Kinex's own reference, shipped with core.
async function reference(directory: string) {
  await mkdir(directory, { recursive: true })
  await cp(fileURLToPath(new URL("../README.md", import.meta.resolve("@kinex/core"))), path.join(directory, "kinex-core.md"))
  await writeFile(path.join(directory, "INDEX.md"), REFERENCE)
}

/** One distillation: trial records and the base library in, a checked candidate out, published as the next version. */
export async function runDistillation(run: Run, job: Job, input: DistillInput): Promise<Result> {
  const trials = await collect(run.root, run.config, input, path.join(job.workspace, "records"))
  await reference(path.join(job.workspace, "reference"))
  await mkdir(path.join(job.workspace, "notes"))
  await cp(versionDir(run.root, input.base), candidateDir(job.workspace), { recursive: true })
  const deadline = Date.now() + input.timeoutS * 1000
  const goals = new Map(trials.map(trial => [trial.task, trial.instruction ?? ""]))
  const fill: Record<string, string> = {
    WORKER_MODEL: "Kinex, the agent and model you are", WORKER_TIMEOUT: String(run.config.trialTimeoutS), SESSION: job.id,
    DEADLINE: new Date(deadline).toISOString(), HOURS: (input.timeoutS / 3600).toFixed(1),
    TASKS: [...goals].sort().map(([task, goal]) => `- ${task}: ${goal}`).join("\n"),
  }
  const prompt = `${FRAME.replaceAll(/\[\[(\w+)\]\]/g, (_, name: string) => fill[name] ?? "")}\n${RULES}`
  const session = await runSession("distiller", job.workspace, job.record, prompt, deadline)
  // An unfinished session may leave a half-written library: only one that ended normally can publish.
  const outcome = session.status === "done" ? await publish(run.root, candidateDir(job.workspace), { parent: input.base, source: job.id }) : {}
  return finishJob(job, { ...session, ...outcome })
}

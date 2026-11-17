import { stat } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { define, type Def } from "@kinex/core"
import { candidateDir, runDistillation } from "./distill.ts"
import { isRunning, openJob, resultOf, runningIDs, start, startJob, wait } from "./job.ts"
import { distillationsDir, recordDir, trialsDir } from "./layout.ts"
import { check, newestVersion, versions } from "./library.ts"
import { describeDistillation, describeTrial, renderStatus, scan, type DistillInput, type TrialInput } from "./records.ts"
import { DEADLINE_VARIABLE } from "./roles.ts"
import { activeRun } from "./run.ts"
import { runSession } from "./session.ts"
import { listTasks } from "./sim.ts"
import { runTrial } from "./trial.ts"

const HELPERS_AT_ONCE = 4
const output = (title: string, text: string) => ({ title, output: text })

function scheduled() {
  const run = activeRun()
  if (!run) throw new Error("No self-improve run is active in this session; the user starts one with /self-improve")
  return run
}

const Tasks = define("improve_tasks", {
  description: "Tasks in rosbridge's catalog that match the pattern, split and count: id and robot. improve_run_trial takes ids.",
  parameters: z.strictObject({
    simulator: z.string().optional().describe("limit to one simulator, e.g. robocasa"),
    pattern: z.string().optional().describe("matched against the whole task id; * matches any characters, e.g. libero/libero-spatial-*"),
    split: z.string().optional().describe("a split the catalog marks, e.g. target"),
    count: z.number().int().positive().optional().describe("at most this many, in id order"),
  }),
  execute: async args => {
    const catalog = await listTasks(scheduled().config.rosbridge, args.simulator)
    const pattern = args.pattern && new RegExp(`^${args.pattern.split("*").map(part => part.replaceAll(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`)
    if (args.split && !catalog.some(task => task.split)) throw new Error("rosbridge does not report task splits; select by pattern or by ids")
    const matched = catalog.filter(task => (!pattern || pattern.test(task.id)) && (!args.split || task.split === args.split)).slice(0, args.count)
    return output(`${matched.length} tasks`, matched.map(task => `${task.id} (robot ${task.robot})`).join("\n") || "No task matches.")
  },
})

const RunTrial = define("improve_run_trial", {
  description: "Start one trial per named task: a fresh sub-agent on each named task, shipped with the newest published library version, or the one named. Returns at once with the trial ids; improve_wait gives the outcomes. At most --parallel run at a time; the rest queue.",
  parameters: z.strictObject({
    tasks: z.array(z.string()).min(1).describe("task ids from improve_tasks"),
    library: z.string().regex(/^L\d+$/).optional().describe("a published version; default: the newest"),
  }),
  execute: async args => {
    const run = scheduled()
    if (runningIDs().some(id => id.startsWith("d"))) throw new Error("A distillation is running; wait for it so the trials ship its library")
    const library = args.library ?? await newestVersion(run.root)
    if (!(await versions(run.root)).includes(library)) throw new Error(`No library version ${library}`)
    const robots = new Map((await listTasks(run.config.rosbridge)).map(task => [task.id, task.robot]))
    const unknown = args.tasks.filter(task => !robots.has(task))
    if (unknown.length) throw new Error(`Unknown tasks: ${unknown.join(", ")}; improve_tasks lists the ids`)
    const started: string[] = []
    for (const task of args.tasks) {
      const input: TrialInput = { task, robot: robots.get(task) ?? "", library, ...(run.config.seed === undefined ? {} : { seed: run.config.seed }), timeoutS: run.config.trialTimeoutS }
      const job = await openJob(trialsDir(run.root), "t", input)
      startJob(job, "trials", run.config.parallel, () => runTrial(run, job, input))
      started.push(`${job.id} ${task}`)
    }
    return output(`${started.length} trials started`, `Started with ${library}, at most ${run.config.parallel} at a time:\n${started.join("\n")}`)
  },
})

const Distill = define("improve_distill", {
  description: "Start one distillation: a separate session that reads every finished trial's record and rewrites the library. If its check passes, the result is published as the next library version. Returns at once with the distillation id; improve_wait gives the outcome. Refused while trials are running or when no finished trial is new.",
  parameters: z.strictObject({}),
  execute: async () => {
    const run = scheduled()
    if (runningIDs().length) throw new Error(`Still running: ${runningIDs().join(", ")}; a distillation starts after every trial of the wave has ended`)
    const status = await scan(run.root)
    if (!status.fresh.length) throw new Error("No finished trial is new since the last published version")
    const input: DistillInput = { base: await newestVersion(run.root), trials: status.trials.filter(trial => trial.status).map(trial => trial.id), fresh: status.fresh, timeoutS: run.config.distillTimeoutS }
    const job = await openJob(distillationsDir(run.root), "d", input)
    startJob(job, "distillations", 1, () => runDistillation(run, job, input))
    return output(`${job.id} started`, `Started ${job.id} from ${input.base} on ${input.trials.length} trials (${input.fresh.length} new).`)
  },
})

const Wait = define("improve_wait", {
  description: "Wait for trials to end and return each outcome: the simulator's verdict (success), the sub-agent's cost (steps, seconds, dollars), with its record in trials/<id>/record/. Also waits for a distillation (whether its check passed and the version it published) and, inside a distillation, for sub-agents started with improve_delegate (done or failed). Waits at most timeout_s; call again while it says running.",
  parameters: z.strictObject({
    ids: z.array(z.string()).optional().describe("default: everything this session started that is still running"),
    mode: z.enum(["all", "any"]).default("all").describe("return when all have ended, or as soon as one has"),
    timeout_s: z.number().positive().default(3600),
  }),
  execute: async (args, ctx) => {
    const ids = args.ids ?? runningIDs()
    if (args.mode === "all" || ids.every(isRunning)) await wait(ids, args.mode, args.timeout_s, ctx.abort)
    const run = activeRun()
    const status = run ? await scan(run.root) : undefined
    const lines = ids.map(id => {
      const trial = status?.trials.find(view => view.id === id)
      const distillation = status?.distillations.find(view => view.id === id)
      if (trial) return describeTrial(trial, isRunning(id))
      if (distillation) return describeDistillation(distillation, isRunning(id))
      return `${id}, ${isRunning(id) ? "running" : resultOf(id)?.status ?? "unknown"}`
    })
    return output(`${ids.filter(id => !isRunning(id)).length}/${ids.length} ended`, lines.join("\n") || "Nothing is running.")
  },
})

const Status = define("improve_status", {
  description: "The run so far: published library versions and tasks solved per version; every trial, oldest first, with its verdict, cost and library version; then distillations and the finished trials not yet distilled.",
  parameters: z.strictObject({}),
  execute: async () => {
    const run = scheduled()
    return output("Self-improve status", renderStatus(run.root, await scan(run.root), isRunning))
  },
})

const Delegate = define("improve_delegate", {
  description: "Start a sub-agent: a separate session that works in this folder on the prompt you write, which is all it knows. Returns at once; improve_wait returns when it ends. What it finds, it must write to a file you name.",
  parameters: z.strictObject({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).describe("unique in this session; lowercase letters, digits and hyphens"),
    prompt: z.string().min(1),
  }),
  execute: async (args, ctx) => {
    // A distiller works in <job>/workspace; its helpers' records go beside its own.
    const record = path.join(recordDir(path.dirname(ctx.directory)), "helpers", args.name)
    if (await stat(record).then(() => true, () => false)) throw new Error(`A sub-agent named ${args.name} was already started`)
    start(args.name, "helpers", HELPERS_AT_ONCE, async () => ({ ...await runSession("helper", ctx.directory, record, args.prompt, Number(process.env[DEADLINE_VARIABLE])) }))
    return output(`${args.name} started`, `Started sub-agent ${args.name}; at most ${HELPERS_AT_ONCE} run at a time.`)
  },
})

const Check = define("improve_check", {
  description: "The gate: loads library/payload the way Kinex would and returns what does not load, and a brief.md longer than 15 lines or 2,000 characters. A library with problems is not published.",
  parameters: z.strictObject({}),
  execute: async (_args, ctx) => {
    const problems = await check(candidateDir(ctx.directory))
    return { title: problems.length ? `${problems.length} problems` : "No problems", output: problems.join("\n") || "No problems: the library may ship.", isError: problems.length > 0 }
  },
})

export const tools: readonly Def[] = [Tasks, RunTrial, Distill, Wait, Status, Delegate, Check]

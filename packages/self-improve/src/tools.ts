import { z } from "zod"
import { define, type Def } from "@kinex/core"
import { currentScope } from "@kinex/core/scope"
import { writeAgents } from "./agents.ts"
import { candidateDir } from "./distill.ts"
import { check } from "./library.ts"
import { currentRole } from "./roles.ts"
import { REPAIRS, createRun, newConfig, rosbridgeCommand, type Config, type Run } from "./run.ts"
import { sandboxName, sandboxSetting } from "./sandbox.ts"
import { checked, current, describe, next, schedule } from "./scheduler.ts"
import { launchOptions, listTasks, matching } from "./sim.ts"

// The session that schedules a run has this package's tools only while it does:
// two to plan one, then one that says what to start next. A distiller has the gate.
export const toolNames: readonly string[] = ["improve_tasks", "improve_plan", "improve_next", "improve_check"]

/** The permission a tool asks for to go on with nobody to approve its steps; the host asks the user once. */
const UNATTENDED = "unattended"

const output = (title: string, text: string) => ({ title, output: text })

/** What the user approves: the tasks, the commands a trial is started, ended and judged with, and what a round is. */
export function planText(config: Pick<Config, "tasks" | "robot" | "rounds" | "parallel" | "batches" | "rosbridge" | "launch" | "seed" | "trialTimeoutS" | "distillTimeoutS">, sandbox: string): string {
  const tasks = config.tasks ?? []
  const seed = config.seed === undefined ? "" : ` --seed ${config.seed}`
  const launch = launchOptions(config.launch)
  const also = launch.length ? ` ${launch.join(" ")}` : ""
  return [
    `Self-improve plan: ${tasks.length} ${tasks.length === 1 ? "task" : "tasks"} of rosbridge's catalog on robot ${config.robot}: ${tasks.join(", ")}`,
    `Rounds: ${config.rounds}. A round is a wave of trials, one for each task still unsolved, ${config.parallel} at a time, then one distillation.${config.batches?.length ? ` Tasks open in batches of ${config.batches.join(", ")}, then the rest, one batch a wave.` : ""}`,
    `A trial starts with \`${config.rosbridge} launch <task> --execution-mode stepped --early-stop --detach${seed}${also}\` on a ROS domain of its own and \`${config.rosbridge} setup <task>\` into a fresh workspace, where one worker sub-agent ${sandbox} attempts the task with the newest library for at most ${config.trialTimeoutS} s. It ends with \`${config.rosbridge} stop\`, and \`${config.rosbridge} judge\` decides the outcome: the simulator's verdict, never the worker's report.`,
    `A distillation is a sub-agent in a folder of its own that turns every trial record into the next library version in at most ${config.distillTimeoutS} s; a version is published only when improve_check finds nothing${REPAIRS ? `, after up to ${REPAIRS} repair turns` : ""}.`,
    "Trials and distillations run in the background with nobody to approve their steps.",
  ].join("\n")
}

// How rosbridge is run is the session's to work out from what the user said, and the user's to approve with the plan.
const ROSBRIDGE = "the command that runs rosbridge where it is not `rosbridge` on PATH: words without quoting, the environment it needs first as NAME=value, e.g. CUDA_VISIBLE_DEVICES=1 /sim/rosbridge/.venv/bin/rosbridge"

const tasksTool = define("improve_tasks", {
  description: "Tasks in rosbridge's catalog that match the pattern, split and count: id and robot. improve_plan takes ids.",
  parameters: z.strictObject({
    rosbridge: z.string().optional().describe(ROSBRIDGE),
    simulator: z.string().optional().describe("limit to one simulator, e.g. robocasa"),
    pattern: z.string().optional().describe("matched against the whole task id; * matches any characters, e.g. libero/libero-spatial-*"),
    split: z.string().optional().describe("a split the catalog marks, e.g. target"),
    count: z.number().int().positive().optional().describe("at most this many, in id order"),
  }),
  execute: async args => {
    const planned = current()
    if (planned && args.rosbridge) planned.rosbridge = args.rosbridge
    const listed = await listTasks(args.rosbridge ?? planned?.rosbridge ?? rosbridgeCommand(), args.simulator)
    if (args.split && !listed.some(task => task.split)) throw new Error("rosbridge does not report task splits; select by pattern or by ids")
    const matched = listed.filter(task => (!args.pattern || matching(args.pattern).test(task.id)) && (!args.split || task.split === args.split)).slice(0, args.count)
    return output(`${matched.length} tasks`, matched.map(task => `${task.id} (robot ${task.robot})`).join("\n") || "No task matches.")
  },
})

const planTool = define("improve_plan", {
  description: "Propose the self-improve run: its tasks, how rosbridge is run for them, rounds and trials at a time. The user is shown the plan with the commands a trial is started, ended and judged with, and approves it; then the run exists and the result gives the call that starts its first sub-agents. Call it once you have told the user the plan.",
  parameters: z.strictObject({
    tasks: z.array(z.string()).min(1).describe("task ids from improve_tasks, all on one robot"),
    rounds: z.number().int().positive().default(1).describe("how many waves of trials are distilled"),
    parallel: z.number().int().positive().default(1).describe("trials at a time"),
    batches: z.array(z.number().int().positive()).optional().describe("sizes of the first batches of tasks to open, one batch a wave; the rest open together after them"),
    rosbridge: z.string().optional().describe(`${ROSBRIDGE}; absent, the one improve_tasks was given`),
    launch: z.array(z.string()).optional().describe("more options for every `rosbridge launch` of the run, each word an item, e.g. [\"--split\", \"target\"]. The execution mode, the early stop and the ROS domain are not yours to give"),
    seed: z.number().int().optional().describe("the seed every trial of a task starts from; absent, the simulator's default state for the task"),
  }),
  execute: async (args, ctx) => {
    const planned = current()
    if (!planned) throw new Error("No self-improve run is being planned; the user starts one with /self-improve")
    if (planned.run) throw new Error(`The self-improve run ${planned.run.root} is already scheduled in this Kinex; /self-improve stop ends it`)
    const rosbridge = args.rosbridge ?? planned.rosbridge ?? rosbridgeCommand()
    const launch = launchOptions(args.launch)
    const catalog = await listTasks(rosbridge)
    const tasks = checked(args.tasks, catalog)
    const robot = catalog.find(task => task.id === tasks[0])?.robot ?? ""
    const config = newConfig(planned.request, { tasks, robot, rounds: args.rounds, parallel: args.parallel, ...(args.batches?.length ? { batches: args.batches } : {}),
      rosbridge, ...(launch.length ? { launch } : {}), ...(args.seed === undefined ? {} : { seed: args.seed }),
      sandbox: sandboxSetting(), ...(currentScope().builtinLibRoots?.length ? { libRoots: [...currentScope().builtinLibRoots ?? []] } : {}) })
    const sandbox = await sandboxName()
    await ctx.ask({ permission: UNATTENDED, description: planText(config, sandbox ? `in a ${sandbox} sandbox` : "without a sandbox") })
    const run = await createRun(config)
    await writeAgents(run)
    schedule({ request: planned.request, run, approved: true })
    return output("Plan approved", `The self-improve run ${run.root} is scheduled.\n\n${await step(run)}`)
  },
})

// The run ends in the step that says so: the session then has none of the tools.
async function step(run: Run): Promise<string> {
  const decided = await next(run)
  if (decided.kind === "end") schedule(undefined)
  return describe(run, decided)
}

const nextTool = define("improve_next", {
  description: "What the scheduled self-improve run needs now, decided from what its trials and distillations have left on disk: the sub-agents to start, that nothing is to be started yet, or how the run ended. Call it whenever a trial or a distillation has ended.",
  parameters: z.strictObject({}),
  execute: async (_args, ctx) => {
    const planned = current()
    if (!planned?.run) throw new Error("No self-improve run is scheduled in this Kinex; /self-improve resume continues one")
    // A resumed run was approved in another session; this one is asked once.
    if (!planned.approved) {
      await ctx.ask({ permission: UNATTENDED, description: `Continue the self-improve run ${planned.run.root} (${planned.run.config.selection}). Its trials and distillations run in the background with nobody to approve their steps.` })
      planned.approved = true
    }
    return output("Next step", await step(planned.run))
  },
})

const checkTool = define("improve_check", {
  description: "The gate: loads library/payload the way Kinex would and returns what does not load, a lib module named like a builtin kinex.lib module, Python in lib/ or programs/ that does not compile, a skill or the brief naming something a lib module does not define, a row in memory/rows that is not a JSON object, and a brief.md longer than 15 lines or 2,000 characters. A library with problems is not published.",
  parameters: z.strictObject({}),
  execute: async (_args, ctx) => {
    const problems = await check(candidateDir(ctx.directory))
    return { title: problems.length ? `${problems.length} problems` : "No problems", output: problems.join("\n") || "No problems: the library may ship.", isError: problems.length > 0 }
  },
})

/** The tools of this process's session: a distiller's gate, or those of the run the user's Kinex plans or schedules. */
export function tools(): Def[] {
  const role = currentRole()
  if (role) return role === "distiller" ? [checkTool] : []
  const planned = current()
  if (!planned) return []
  return planned.run ? [nextTool] : [tasksTool, planTool]
}

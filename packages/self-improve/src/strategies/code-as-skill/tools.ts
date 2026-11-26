import { z } from "zod"
import { define, type Def } from "@kinex/core"
import { ConfigPaths } from "@kinex/core/config/paths"
import { currentScope } from "@kinex/core/scope"
import { homeOf, pythonDir, runOf, selfImproveDir } from "../../common/layout.ts"
import { COMMAND, LAUNCH, UNATTENDED, checked } from "../../common/plan.ts"
import { openRunAt } from "../../common/run.ts"
import { sandboxName } from "../../common/sandbox.ts"
import { current, schedule } from "../../common/schedule.ts"
import { KINEX_SIM, launchOptions, listTasks } from "../../common/sim.ts"
import { writeAgents } from "./agents.ts"
import { candidateDir } from "./distill.ts"
import { check } from "./library.ts"
import { CHECK, NEXT, PLAN, STRATEGY } from "./names.ts"
import { DISTILLER } from "./roles.ts"
import { REPAIRS, createRun, newConfig, type Config, type Run } from "./run.ts"
import { describe, next } from "./scheduler.ts"

// The session that schedules a run has this strategy's tools only while it does:
// one to plan it, then one that says what to start next. A distiller has the gate.
// The session finds the tasks itself, with kinex-sim's own `tasks list`.
export const toolNames: readonly string[] = [PLAN, NEXT, CHECK]

const output = (title: string, text: string) => ({ title, output: text })

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`

/**
 * What the user approves, in sections: the tasks, what a round is, how kinex-sim is run, the commands a
 * trial is started, ended and judged with, what a distillation publishes, and the sandbox its sub-agents run in.
 * The dialog shows it as one block of text, so a section is a heading line with its lines indented under it.
 */
export function planText(config: Pick<Config, "tasks" | "robot" | "rounds" | "parallel" | "batches" | "command" | "launch" | "seed" | "trialTimeoutS" | "distillTimeoutS">, sandbox: string): string {
  const tasks = config.tasks ?? []
  const seed = config.seed === undefined ? "" : ` --seed ${config.seed}`
  const launch = launchOptions(config.launch)
  const also = launch.length ? ` ${launch.join(" ")}` : ""
  return [
    `${STRATEGY} plan: ${plural(tasks.length, "task")} on robot ${config.robot}`,
    ...tasks.map(task => `  ${task}`),
    "",
    `${plural(config.rounds, "round")}, ${plural(config.parallel, "trial")} at a time`,
    "  A round is a wave of trials, one for each task still unsolved, then one distillation.",
    ...(config.batches?.length ? [`  Tasks open in batches of ${config.batches.join(", ")}, then the rest, one batch a wave.`] : []),
    "",
    ...(config.command === KINEX_SIM ? ["kinex-sim, below, is the one on PATH"] : ["kinex-sim, below, is run as", `  ${config.command}`]),
    "",
    `A trial: one worker sub-agent with the newest library, in a fresh workspace, for at most ${config.trialTimeoutS} s`,
    `  start  kinex-sim launch <task> --execution-mode stepped --early-stop --detach${seed}${also}`,
    "         on a ROS domain of its own, then kinex-sim setup <task> into the workspace",
    "  end    kinex-sim stop",
    "  judge  kinex-sim judge: the simulator's verdict, never the worker's report",
    "",
    `A distillation: one sub-agent in a folder of its own, for at most ${config.distillTimeoutS} s`,
    "  It turns every trial record into the next library version,",
    `  published only when ${CHECK} finds nothing${REPAIRS ? `, after up to ${REPAIRS} repair turns` : ""}.`,
    "",
    "Trials and distillations run in the background with nobody to approve their steps,",
    `each in a ${sandbox} sandbox that shows it only its own folder.`,
  ].join("\n")
}

const planTool = define(PLAN, {
  description: "Propose the code-as-skill run: its tasks, how kinex-sim is run for them, rounds and trials at a time. The user is shown the plan with the commands a trial is started, ended and judged with, and approves it; then the run exists and the result gives the call that starts its first sub-agents. Call it once you have told the user the plan.",
  parameters: z.strictObject({
    tasks: z.array(z.string()).min(1).describe("task ids from `kinex-sim tasks list`, all on one robot"),
    rounds: z.number().int().positive().default(1).describe("how many waves of trials are distilled"),
    parallel: z.number().int().positive().default(1).describe("trials at a time"),
    batches: z.array(z.number().int().positive()).optional().describe("sizes of the first batches of tasks to open, one batch a wave; the rest open together after them"),
    command: z.string().optional().describe(COMMAND),
    launch: z.array(z.string()).optional().describe(LAUNCH),
    seed: z.number().int().optional().describe("the seed every trial of a task starts from; absent, the simulator's default state for the task"),
  }),
  execute: async (args, ctx) => {
    const planned = current()
    if (planned?.strategy !== STRATEGY) throw new Error(`No ${STRATEGY} run is being planned; the user starts one with /${STRATEGY}`)
    if (planned.root) throw new Error(`The ${STRATEGY} run ${planned.root} is already scheduled in this Kinex; /${STRATEGY} stop ends it`)
    const command = args.command ?? KINEX_SIM
    const launch = launchOptions(args.launch)
    const catalog = await listTasks(command)
    const tasks = checked(args.tasks, catalog)
    const robot = catalog.find(task => task.id === tasks[0])?.robot ?? ""
    const config = newConfig(planned.request, { tasks, robot, rounds: args.rounds, parallel: args.parallel, ...(args.batches?.length ? { batches: args.batches } : {}),
      command, ...(launch.length ? { launch } : {}), ...(args.seed === undefined ? {} : { seed: args.seed }),
      ...(currentScope().builtinLibRoots?.length ? { libRoots: [...currentScope().builtinLibRoots ?? []] } : {}) })
    // The run belongs to this workspace. A host where no sandbox can run has its plan refused here, before anything exists.
    const kinex = await ConfigPaths.projectDir(ctx.directory)
    const sandbox = await sandboxName({ python: pythonDir(selfImproveDir(kinex)) })
    await ctx.ask({ permission: UNATTENDED, description: planText(config, sandbox) })
    const run = await createRun(kinex, config)
    await writeAgents(run.root)
    schedule({ strategy: STRATEGY, request: planned.request, root: run.root, approved: true })
    return output("Plan approved", `The ${STRATEGY} run ${run.root} is scheduled.\n\n${await step(run)}`)
  },
})

// The run ends in the step that says so: the session then has none of the tools.
async function step(run: Run): Promise<string> {
  const decided = await next(run)
  if (decided.kind === "end") schedule(undefined)
  return describe(run, decided)
}

const nextTool = define(NEXT, {
  description: "What the scheduled code-as-skill run needs now, decided from what its trials and distillations have left on disk: the sub-agents to start, that nothing is to be started yet, or how the run ended. Call it whenever a trial or a distillation has ended.",
  parameters: z.strictObject({}),
  execute: async (_args, ctx) => {
    const planned = current()
    if (planned?.strategy !== STRATEGY || !planned.root) throw new Error(`No ${STRATEGY} run is scheduled in this Kinex; /${STRATEGY} resume continues one`)
    // The run's settings as its folder keeps them now: they can be edited while no job runs.
    const run = await openRunAt<Config>(planned.root)
    // A resumed run was approved in another session; this one is asked once.
    if (!planned.approved) {
      await ctx.ask({ permission: UNATTENDED, description: `Continue the ${STRATEGY} run ${run.root} (${run.config.selection}). Its trials and distillations run in the background with nobody to approve their steps.` })
      planned.approved = true
    }
    return output("Next step", await step(run))
  },
})

const checkTool = define(CHECK, {
  description: "The gate: loads library/payload the way Kinex would and returns what does not load, a lib module named like a builtin kinex.lib module, Python in lib/ or programs/ that does not compile, a skill or the brief naming something a lib module does not define, a row in memory/rows that is not a JSON object, and a brief.md longer than 15 lines or 2,000 characters. A library with problems is not published.",
  parameters: z.strictObject({}),
  execute: async (_args, ctx) => {
    // A distiller works in its distillation's workspace, inside the run whose trials' Python compiles its code.
    const problems = await check(candidateDir(ctx.directory), pythonDir(homeOf(runOf(ctx.directory))))
    return { title: problems.length ? `${problems.length} problems` : "No problems", output: problems.join("\n") || "No problems: the library may ship.", isError: problems.length > 0 }
  },
})

/** The tools of a session: a distiller's gate, or those of the user's session while it plans or schedules a run of this strategy. */
export function tools(role?: string): Def[] {
  if (role) return role === DISTILLER.name ? [checkTool] : []
  const planned = current()
  if (planned?.strategy !== STRATEGY) return []
  return planned.root ? [nextTool] : [planTool]
}

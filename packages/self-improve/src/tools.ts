import path from "node:path"
import { z } from "zod"
import { define, type Def } from "@kinex/core"
import { startTool, tools as jobTools, type Tool } from "@kinex/jobs/tools"
import { candidateDir } from "./distill.ts"
import { check } from "./library.ts"
import { saveTasks } from "./run.ts"
import { checked, type Phase, type Scheduled } from "./scheduler.ts"
import { runSession } from "./session.ts"
import { listTasks, matching } from "./sim.ts"

// The main session has this package's tools only while the scheduler has given it
// a turn: two to convert a free-text request into tasks, three to distill.
export const toolNames: readonly string[] = ["improve_tasks", "improve_select", "improve_delegate", "improve_wait", "improve_check"]

const output = (title: string, text: string) => ({ title, output: text })

// A tool of @kinex/jobs as Kinex runs its own: the arguments checked against its schema, the result in Kinex's form.
function adopt<Args>(tool: Tool<Args>): Def {
  return define(tool.name, {
    description: tool.description,
    parameters: z.fromJSONSchema(tool.parameters as Parameters<typeof z.fromJSONSchema>[0]),
    execute: async (args, ctx) => {
      const result = await tool.execute(args as Args, ctx.abort)
      return { title: result.title, output: result.text, ...(result.isError ? { isError: true } : {}) }
    },
  })
}

function selectTools({ run }: Scheduled, { catalog }: Extract<Phase, { kind: "select" }>): Def[] {
  return [
    define("improve_tasks", {
      description: "Tasks in rosbridge's catalog that match the pattern, split and count: id and robot. improve_select takes ids.",
      parameters: z.strictObject({
        simulator: z.string().optional().describe("limit to one simulator, e.g. robocasa"),
        pattern: z.string().optional().describe("matched against the whole task id; * matches any characters, e.g. libero/libero-spatial-*"),
        split: z.string().optional().describe("a split the catalog marks, e.g. target"),
        count: z.number().int().positive().optional().describe("at most this many, in id order"),
      }),
      execute: async args => {
        const listed = args.simulator ? await listTasks(run.config.rosbridge, args.simulator) : catalog
        if (args.split && !listed.some(task => task.split)) throw new Error("rosbridge does not report task splits; select by pattern or by ids")
        const matched = listed.filter(task => (!args.pattern || matching(args.pattern).test(task.id)) && (!args.split || task.split === args.split)).slice(0, args.count)
        return output(`${matched.length} tasks`, matched.map(task => `${task.id} (robot ${task.robot})`).join("\n") || "No task matches.")
      },
    }),
    define("improve_select", {
      description: "Set the tasks this self-improve run practises: ids from improve_tasks, all on one robot. Call it once; the trials start when your turn ends.",
      parameters: z.strictObject({ tasks: z.array(z.string()).min(1).describe("task ids from improve_tasks") }),
      execute: async args => {
        const tasks = checked(args.tasks, catalog)
        await saveTasks(run, tasks)
        return output(`${tasks.length} tasks selected`, `The run practises: ${tasks.join(", ")}.`)
      },
    }),
  ]
}

function distillTools({ distillation, helpers }: Extract<Phase, { kind: "distill" }>): Def[] {
  const { workspace, record } = distillation.job
  return [
    adopt(startTool<{ name: string; prompt: string }>(helpers, {
      name: "improve_delegate", lane: "helpers",
      description: "Start a sub-agent: a separate session that works in this folder on the prompt you write, which is all it knows. Returns at once; improve_wait returns when it ends. What it finds, it must write to a file you name.",
      parameters: { type: "object", additionalProperties: false, required: ["name", "prompt"], properties: {
        name: { type: "string", pattern: "^[a-z0-9][a-z0-9-]*$", description: "unique in this session; lowercase letters, digits and hyphens" },
        prompt: { type: "string", minLength: 1 },
      } },
      // A sub-agent's record goes beside the distiller's own; it ends with the distillation.
      job: args => ({ id: args.name, run: async signal => {
        const exit = await runSession("helper", workspace, path.join(record, "helpers", args.name), args.prompt, distillation.deadline, { signal })
        return { status: exit.status, summary: `${exit.wallS} s` }
      } }),
    })),
    adopt({ ...jobTools(helpers, { prefix: "improve" }).wait,
      description: "Wait for sub-agents started with improve_delegate to end and return one line for each: done, error or timeout. Waits at most timeout_s; call again while it says running." }),
    define("improve_check", {
      description: "The gate: loads library/payload the way Kinex would and returns what does not load, a lib module named like a builtin kinex.lib module, Python in lib/ or programs/ that does not compile, a skill or the brief naming something a lib module does not define, a row in memory/rows that is not a JSON object, and a brief.md longer than 15 lines or 2,000 characters. A library with problems is not published.",
      parameters: z.strictObject({}),
      execute: async () => {
        const problems = await check(candidateDir(workspace))
        return { title: problems.length ? `${problems.length} problems` : "No problems", output: problems.join("\n") || "No problems: the library may ship.", isError: problems.length > 0 }
      },
    }),
  ]
}

const built = new WeakMap<Phase, Def[]>()

/** The tools of the turn the scheduler has given the session in `directory`, if it has given it one. */
export function toolsOf(state: Scheduled | undefined, directory: string): Def[] {
  const phase = state?.phase
  if (!state || !phase || (phase.kind === "distill" && phase.distillation.job.workspace !== directory)) return []
  if (!built.has(phase)) built.set(phase, phase.kind === "select" ? selectTools(state, phase) : distillTools(phase))
  return built.get(phase) ?? []
}

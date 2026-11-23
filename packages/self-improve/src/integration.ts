import type { CommandContext, CommandResult, KinexRuntime } from "@kinex/core"
import type { KinexContribution } from "@kinex/core/integration"
import { toModelSchema } from "@kinex/core/tool/registry"
import { writeAgents } from "./agents.ts"
import { versionDir } from "./layout.ts"
import { PARTS, install, installedBrief, versions } from "./library.ts"
import { renderStatus, scan } from "./records.ts"
import { currentRole } from "./roles.ts"
import { openRun } from "./run.ts"
import { current, live, schedule, stop } from "./scheduler.ts"
import { toolNames, tools } from "./tools.ts"
import PLAN from "./plan.txt"

export const selfImproveToolNames = toolNames

const USAGE = "Usage: /self-improve <what to practise> | status [run] | install <version> [run] | resume [run] | stop"

export function selfImproveContribution(runtime: KinexRuntime): KinexContribution {
  // Whether this session was given a brief, so that it is also told when one is removed.
  const session: { briefed?: boolean } = {}
  async function execute(args: string, context: CommandContext): Promise<CommandResult> {
    context.signal?.throwIfAborted()
    if (currentRole()) throw new Error("/self-improve is not available inside a self-improve session")
    const tokens = args.trim().split(/\s+/).filter(Boolean)
    const [first, second, third] = tokens
    if (first === "status") {
      const run = await openRun(second)
      const status = await scan(run.root)
      const jobs = await live(run.root, status)
      return { kind: "output", text: renderStatus(run.root, status, id => jobs.waiting.has(id) || jobs.running.has(id)) }
    }
    if (first === "install") {
      if (!second) throw new Error(USAGE)
      const run = await openRun(third)
      // A folder that is not a published version would install as an empty library.
      const known = await versions(run.root)
      if (!known.includes(second)) throw new Error(`No library version ${second} in ${run.root}; versions: ${known.join(", ")}`)
      const installed = await install(versionDir(run.root, second), runtime.directory)
      return { kind: "output", text: `Installed ${second} of ${run.root}: ${PARTS.map(part => `${part} ${installed[part].join(", ") || "none"}`).join("; ")}` }
    }
    if (first === "stop") {
      if (second) throw new Error(USAGE)
      // After Kinex was started again no run is scheduled here, and the newest may still have jobs running.
      const run = current()?.run ?? await openRun().catch(() => undefined)
      const stopped = run ? await stop(run) : []
      const planned = current()
      schedule(undefined)
      if (!run || (!planned && !stopped.length)) return { kind: "output", text: "No self-improve run is scheduled in this Kinex." }
      return { kind: "output", text: `Stopped the self-improve run ${run.root}${stopped.length ? `: ${stopped.join(", ")} ended and count as abandoned` : ""}. /self-improve resume continues it from what is finished.` }
    }
    if (current()?.run) throw new Error(`The self-improve run ${current()?.run?.root} is already scheduled in this Kinex; /self-improve stop ends it`)
    if (first === "resume") {
      const run = await openRun(second)
      await writeAgents(run)
      schedule({ request: run.config.selection, run })
      return { kind: "workflow", prompt: `The self-improve run ${run.root} (${run.config.selection}) is scheduled in this Kinex again. Call improve_next and do what it says: it names the sub-agents to start with the subagent tool. Do not attempt the tasks yourself.` }
    }
    if (!tokens.length) throw new Error(USAGE)
    // The session plans the run with the user; improve_plan makes it once the user has approved.
    schedule({ request: args.trim() })
    return { kind: "workflow", prompt: PLAN.trim().replaceAll("$REQUEST", () => args.trim()) }
  }
  return {
    id: "self-improve",
    tools: {
      list: () => runtime.operation(async () => ({ tools: tools().map(toModelSchema), problems: [] as string[] })),
      call(name, input, call) {
        const def = tools().find(tool => tool.id === name)
        if (!def) throw new Error(`unknown self-improve tool "${name}"`)
        return runtime.tools.execute(def, input, { sessionID: call.sessionID, callID: call.callID, signal: call.abort, ask: call.ask, questions: call.questions })
      },
    },
    // An installed library's brief is a context section of every session in that
    // workspace, not an instruction: the host sends it before the first request,
    // again only when it changes and after compaction, and the stable prompt stays
    // the same when a library is installed or its brief is edited.
    context: () => runtime.operation(async () => {
      const sections: Record<string, string> = {}
      const brief = await installedBrief(runtime.directory)
      if (brief || session.briefed) sections.brief = brief
      if (brief) session.briefed = true
      return { instructions: "", sections }
    }),
    commands: [{
      name: "self-improve", description: "Practise simulated tasks and distill a library of skills and code",
      arguments: "<what to practise> | status | install <version> | resume | stop", kind: "workflow",
      execute: (args, context) => runtime.operation(() => execute(args, context), context.signal),
    }],
  }
}

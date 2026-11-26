import type { CommandContext, CommandResult, KinexRuntime } from "@kinex/core"
import { ConfigPaths } from "@kinex/core/config/paths"
import type { KinexContribution } from "@kinex/core/integration"
import { toModelSchema } from "@kinex/core/tool/registry"
import { writeAgents } from "./common/agents.ts"
import { versionDir } from "./common/layout.ts"
import { PARTS, install, installedBrief, versions } from "./strategies/code-as-skill/library.ts"
import { renderStatus, scan } from "./strategies/code-as-skill/records.ts"
import { currentRole } from "./common/roles.ts"
import { openRun } from "./strategies/code-as-skill/run.ts"
import { current, live, schedule, stop } from "./strategies/code-as-skill/scheduler.ts"
import { toolNames, tools } from "./strategies/code-as-skill/tools.ts"
import PLAN from "./strategies/code-as-skill/plan.txt"

export const selfImproveToolNames = toolNames

// A run is one of this workspace's by name, or any run by its folder.
const USAGE = "Usage: /self-improve <what to practise> | status [run] | install <version> [run] | resume [run] | stop"

export function selfImproveContribution(runtime: KinexRuntime): KinexContribution {
  // Whether this session was given a brief, so that it is also told when one is removed.
  const session: { briefed?: boolean } = {}
  // Runs belong to the workspace they were planned in: this one's Kinex folder holds them.
  const kinex = () => ConfigPaths.projectDir(runtime.directory)
  async function execute(args: string, context: CommandContext): Promise<CommandResult> {
    context.signal?.throwIfAborted()
    if (currentRole()) throw new Error("/self-improve is not available inside a self-improve session")
    const tokens = args.trim().split(/\s+/).filter(Boolean)
    const [first, second, third] = tokens
    if (first === "status") {
      const run = await openRun(await kinex(), second)
      const status = await scan(run.root)
      const jobs = await live(run.root, status)
      return { kind: "output", text: renderStatus(run.root, status, id => jobs.has(id)) }
    }
    if (first === "install") {
      if (!second) throw new Error(USAGE)
      const run = await openRun(await kinex(), third)
      // A folder that is not a published version would install as an empty library.
      const known = await versions(run.root)
      if (!known.includes(second)) throw new Error(`No library version ${second} in ${run.root}; versions: ${known.join(", ")}`)
      const installed = await install(versionDir(run.root, second), runtime.directory)
      return { kind: "output", text: `Installed ${second} of ${run.root}: ${PARTS.map(part => `${part} ${installed[part].join(", ") || "none"}`).join("; ")}` }
    }
    if (first === "stop") {
      if (second) throw new Error(USAGE)
      // After Kinex was started again no run is scheduled here, and the newest may still have jobs running.
      const run = current()?.run ?? await openRun(await kinex()).catch(() => undefined)
      const stopped = run ? await stop(run) : []
      const planned = current()
      schedule(undefined)
      if (!run || (!planned && !stopped.length)) return { kind: "output", text: "No self-improve run is scheduled in this Kinex." }
      return { kind: "output", text: `Stopped the self-improve run ${run.root}${stopped.length ? `: ${stopped.join(", ")} ended and count as abandoned` : ""}. /self-improve resume continues it from what is finished.` }
    }
    if (current()?.run) throw new Error(`The self-improve run ${current()?.run?.root} is already scheduled in this Kinex; /self-improve stop ends it`)
    if (first === "resume") {
      const run = await openRun(await kinex(), second)
      await writeAgents(run)
      schedule({ request: run.config.selection, run })
      return { kind: "workflow", prompt: `The self-improve run ${run.root} (${run.config.selection}) is scheduled in this Kinex again. Call improve_next and do what it says: it gives the calls of the subagent tool that start the next sub-agents. Do not attempt the tasks yourself.` }
    }
    if (!tokens.length) throw new Error(USAGE)
    // The session plans the run with the user; improve_plan makes it once the user has approved.
    schedule({ request: args.trim() })
    return { kind: "workflow", prompt: PLAN.trim().replaceAll("$REQUEST", () => args.trim()) }
  }
  // What completes after the command: its subcommands, and the newest run's versions to install.
  async function choices(): Promise<string[]> {
    if (currentRole()) return []
    const run = await openRun(await kinex()).catch(() => undefined)
    return ["status", "stop", "resume", ...(run ? (await versions(run.root)).map(version => `install ${version}`) : [])]
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
      choices,
      execute: (args, context) => runtime.operation(() => execute(args, context), context.signal),
    }],
  }
}

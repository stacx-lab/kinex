import type { CommandContext, CommandResult, KinexRuntime } from "@kinex/core"
import type { KinexContribution } from "@kinex/core/integration"
import { toModelSchema } from "@kinex/core/tool/registry"
import { versionDir } from "./layout.ts"
import { PARTS, install, installedBrief, versions } from "./library.ts"
import { renderStatus, scan } from "./records.ts"
import { currentRole } from "./roles.ts"
import { createRun, openRun, type Run } from "./run.ts"
import { current, running, start } from "./scheduler.ts"
import { toolNames, toolsOf } from "./tools.ts"

export const selfImproveToolNames = toolNames

const USAGE = "Usage: /self-improve <tasks> [--rounds N] [--parallel N] | status [run] | install <version> [run] | resume [run] | stop"

export function selfImproveContribution(runtime: KinexRuntime): KinexContribution {
  // Whether this session was given a brief, so that it is also told when one is removed.
  const session: { briefed?: boolean } = {}
  // A worker or a helper has none of the tools; the user's process has those of the turn the scheduler gave it.
  const visible = () => currentRole() ? [] : toolsOf(current(), runtime.directory)
  // A run's trials are started by code and its distillations are turns of this session, with nobody to approve them.
  async function schedule(run: Run, context: CommandContext): Promise<CommandResult> {
    if (!context.turn) throw new Error("This host cannot give the session a turn, which /self-improve needs to distill")
    if (context.unattended && !await context.unattended("A self-improve run distills in this session without asking for approval"))
      throw new Error("A self-improve run distills in this session without asking for approval: switch with /mode auto, or start Kinex with --auto, and run the command again")
    const { ended } = start(run, { turn: context.turn })
    return { kind: "output", background: ended, text: `Scheduling the self-improve run ${run.root} (request: ${run.config.selection}; ${run.config.rounds} rounds, ${run.config.parallel} trials at a time). `
      + "Trials run in the background and each distillation takes a turn of this session in a folder of its own. /self-improve status shows progress and /self-improve stop ends it." }
  }
  async function execute(args: string, context: CommandContext): Promise<CommandResult> {
    context.signal?.throwIfAborted()
    if (currentRole()) throw new Error("/self-improve is not available inside a self-improve session")
    const tokens = args.trim().split(/\s+/).filter(Boolean)
    const option = (name: string, fallback: number) => {
      const index = tokens.indexOf(`--${name}`)
      if (index < 0) return fallback
      const value = Number(tokens.splice(index, 2)[1])
      if (!Number.isInteger(value) || value < 1) throw new Error(`--${name} needs a positive whole number`)
      return value
    }
    const [first, second, third] = tokens
    if (first === "status") {
      const run = await openRun(second)
      return { kind: "output", text: renderStatus(run.root, await scan(run.root), running(run.root)) }
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
      const scheduled = current()
      if (!scheduled) return { kind: "output", text: "No self-improve run is scheduled in this Kinex." }
      // Not awaited: a distillation's turn ends by leaving the session this command was typed in.
      scheduled.stop()
      return { kind: "output", text: `Stopping the self-improve run ${scheduled.run.root}.` }
    }
    if (first === "resume") return schedule(await openRun(second), context)
    const settings = { rounds: option("rounds", 1), parallel: option("parallel", 1) }
    if (!tokens.length) throw new Error(USAGE)
    if (current()) throw new Error(`The self-improve run ${current()?.run.root} is already scheduled in this Kinex; /self-improve stop ends it`)
    return schedule(await createRun(tokens.join(" "), settings), context)
  }
  return {
    id: "self-improve",
    tools: {
      list: () => runtime.operation(async () => ({ tools: visible().map(toModelSchema), problems: [] as string[] })),
      call(name, input, call) {
        const def = visible().find(tool => tool.id === name)
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
      arguments: "<tasks> [--rounds N] [--parallel N] | status | install <version> | resume | stop", kind: "workflow",
      // Inside the runtime, as a tracked operation; a run it starts is the process's and outlives it.
      execute: (args, context) => runtime.operation(() => execute(args, context), context.signal),
    }],
  }
}

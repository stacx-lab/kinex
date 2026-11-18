import type { CommandContext, CommandResult, KinexRuntime } from "@kinex/core"
import type { KinexContribution } from "@kinex/core/integration"
import { toModelSchema } from "@kinex/core/tool/registry"
import { isRunning, runningIDs } from "./job.ts"
import { versionDir } from "./layout.ts"
import { PARTS, install, installedBrief, versions } from "./library.ts"
import SCHEDULER from "./scheduler.txt"
import STOPPED from "./stopped.txt"
import { renderStatus, scan } from "./records.ts"
import { currentRole, roles, schedulerTools } from "./roles.ts"
import { createRun, openRun, withRun, type Run } from "./run.ts"
import { tools } from "./tools.ts"

export const selfImproveToolNames: readonly string[] = tools.map(tool => tool.id)

const USAGE = "Usage: /self-improve <tasks> [--rounds N] [--parallel N] | status [run] | install <version> [run] | resume [run] | stop"

// The rules that make a session the scheduler. They travel as a context section,
// which Kinex restores after compaction; the command's prompt only starts the work.
const rules = (run: Run) => SCHEDULER.trim().replaceAll("$ROOT", () => run.root)
  .replaceAll("$SELECTION", () => run.config.selection).replaceAll("$ROUNDS", String(run.config.rounds))

export function selfImproveContribution(runtime: KinexRuntime): KinexContribution {
  // What this session schedules. A host makes its contributions for one session,
  // so the role ends with it: /new, a resumed session or another workspace is an
  // ordinary session again, and /self-improve resume takes the run up where it is.
  // `left` is the run this session stopped scheduling, which it must be told, and
  // `briefed` whether it was given a brief, so it is also told when one is removed.
  const session: { run?: Run; left?: Run; briefed?: boolean } = {}
  const schedule = (run: Run, action: string): CommandResult => {
    session.run = run
    session.left = undefined
    return { kind: "workflow", prompt: `${action} the self-improve run ${run.root} (request: ${run.config.selection}). Follow its scheduler rules.` }
  }
  // A child session gets its role's tools; the user's session gets the scheduler's while it schedules a run.
  const visible = () => {
    const role = currentRole()
    const names = role ? roles[role].tools : session.run ? schedulerTools : []
    return tools.filter(tool => names.includes(tool.id))
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
      return { kind: "output", text: renderStatus(run.root, await scan(run.root), isRunning) }
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
    if (first === "resume") return schedule(await openRun(second), "Continue")
    if (first === "stop") {
      if (second) throw new Error(USAGE)
      const run = session.run
      if (!run) return { kind: "output", text: "This session schedules no self-improve run." }
      session.run = undefined
      session.left = run
      // Leaving the role ends no work: jobs belong to the runtime, and status or resume finds them.
      const running = runningIDs()
      return { kind: "output", text: `Stopped scheduling ${run.root} in this session.${running.length ? ` Still running: ${running.join(", ")}; /self-improve status shows them and /self-improve resume continues the run.` : ""}` }
    }
    const settings = { rounds: option("rounds", 1), parallel: option("parallel", 1) }
    if (!tokens.length) throw new Error(USAGE)
    return schedule(await createRun(tokens.join(" "), settings), "Start")
  }
  return {
    id: "self-improve",
    tools: {
      list: () => runtime.operation(async () => ({ tools: visible().map(toModelSchema), problems: [] as string[] })),
      call(name, input, call) {
        const def = visible().find(tool => tool.id === name)
        if (!def) throw new Error(`unknown self-improve tool "${name}"`)
        return withRun(session.run, () => runtime.tools.execute(def, input, { sessionID: call.sessionID, callID: call.callID, signal: call.abort, ask: call.ask, questions: call.questions }))
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
      if (session.run) sections.run = rules(session.run)
      else if (session.left) sections.run = STOPPED.trim().replaceAll("$ROOT", () => session.left?.root ?? "")
      return { instructions: "", sections }
    }),
    commands: [{
      name: "self-improve", description: "Practise simulated tasks and distill a library of skills and code",
      arguments: "<tasks> [--rounds N] [--parallel N] | status | install <version> | resume | stop", kind: "workflow",
      // Inside the runtime, as a tracked operation: the jobs the command reports are this runtime's.
      execute: (args, context) => runtime.operation(() => execute(args, context), context.signal),
    }],
  }
}

import type { CommandContext, CommandResult, KinexRuntime } from "@kinex/core"
import type { KinexContribution } from "@kinex/core/integration"
import { toModelSchema } from "@kinex/core/tool/registry"
import { isRunning } from "./job.ts"
import { versionDir } from "./layout.ts"
import { install, installedBrief } from "./library.ts"
import SCHEDULER from "./scheduler.txt"
import { renderStatus, scan } from "./records.ts"
import { currentRole, roles, schedulerTools } from "./roles.ts"
import { activate, activeRun, createRun, openRun, type Run } from "./run.ts"
import { tools } from "./tools.ts"

export const selfImproveToolNames: readonly string[] = tools.map(tool => tool.id)

const USAGE = "Usage: /self-improve <tasks> [--rounds N] [--parallel N] | status [run] | install <version> [run] | resume [run]"

// The rules that make a session the scheduler. They travel as a context section,
// which Kinex restores after compaction; the command's prompt only starts the work.
const rules = (run: Run) => SCHEDULER.trim().replaceAll("$ROOT", () => run.root)
  .replaceAll("$SELECTION", () => run.config.selection).replaceAll("$ROUNDS", String(run.config.rounds))

function schedule(run: Run, action: string): CommandResult {
  activate(run)
  return { kind: "workflow", prompt: `${action} the self-improve run ${run.root} (request: ${run.config.selection}). Follow its scheduler rules.` }
}

export function selfImproveContribution(runtime: KinexRuntime): KinexContribution {
  // A child session gets its role's tools; the user's session gets the scheduler's while it schedules a run.
  const visible = () => {
    const role = currentRole()
    const names = role ? roles[role].tools : activeRun() ? schedulerTools : []
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
      const installed = await install(versionDir(run.root, second), runtime.directory)
      return { kind: "output", text: `Installed ${second} of ${run.root}: skills ${installed.skills.join(", ") || "none"}; tools ${installed.tools.join(", ") || "none"}` }
    }
    if (first === "resume") return schedule(await openRun(second), "Continue")
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
        return runtime.tools.execute(def, input, { sessionID: call.sessionID, callID: call.callID, signal: call.abort, ask: call.ask, questions: call.questions })
      },
    },
    // An installed library's brief is part of the instructions of every session in that workspace.
    context: () => runtime.operation(async () => {
      const run = currentRole() ? undefined : activeRun()
      return { instructions: await installedBrief(runtime.directory), sections: run ? { run: rules(run) } : {} as Record<string, string> }
    }),
    commands: [{
      name: "self-improve", description: "Practise simulated tasks and distill a library of skills and tools",
      arguments: "<tasks> [--rounds N] [--parallel N] | status | install <version> | resume", kind: "workflow", execute,
    }],
  }
}

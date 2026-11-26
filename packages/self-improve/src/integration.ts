import type { CommandContext, CommandResult, Def, KinexRuntime } from "@kinex/core"
import { ConfigPaths } from "@kinex/core/config/paths"
import type { KinexContribution } from "@kinex/core/integration"
import { toModelSchema } from "@kinex/core/tool/registry"
import { currentRole } from "./common/roles.ts"
import { openRun } from "./common/run.ts"
import { current, schedule, stopJobs } from "./common/schedule.ts"
import type { Strategy } from "./common/strategy.ts"
import { STRATEGIES, strategyNamed } from "./strategies/index.ts"

export const selfImproveToolNames: readonly string[] = STRATEGIES.flatMap(strategy => strategy.toolNames)

/** The tools of this process's session: those of a child's role, or those of the strategy whose run the user's Kinex plans or schedules. */
function tools(): Def[] {
  const role = currentRole()
  if (role) return strategyNamed(role.strategy)?.tools(role.name) ?? []
  const planned = current()
  return planned ? strategyNamed(planned.strategy)?.tools() ?? [] : []
}

const output = (text: string): CommandResult => ({ kind: "output", text })

export function selfImproveContribution(runtime: KinexRuntime): KinexContribution {
  // The context sections this session was given, so that it is also told when one is removed.
  const given = new Set<string>()
  // Runs belong to the workspace they were planned in: this one's Kinex folder holds them.
  const kinex = () => ConfigPaths.projectDir(runtime.directory)

  async function execute(strategy: Strategy, args: string, context: CommandContext): Promise<CommandResult> {
    context.signal?.throwIfAborted()
    const { name } = strategy
    if (currentRole()) throw new Error(`/${name} is not available inside a self-improvement session`)
    const usage = `Usage: /${name} ${strategy.arguments}`
    const [first, ...rest] = args.trim().split(/\s+/).filter(Boolean)
    if (first === "status") {
      if (rest.length > 1) throw new Error(usage)
      return output(await strategy.status((await openRun(await kinex(), name, rest[0])).root))
    }
    const own = first === undefined ? undefined : strategy.subcommands?.[first]
    if (own) return output(await own(rest, { directory: runtime.directory, kinex: await kinex() }))
    if (first === "stop") {
      if (rest.length) throw new Error(usage)
      const planned = current()?.strategy === name ? current() : undefined
      // After Kinex was started again no run is scheduled here, and the newest may still have jobs running.
      const root = planned?.root ?? (await openRun(await kinex(), name).catch(() => undefined))?.root
      const stopped = root ? await stopJobs(strategy.jobFolders(root)) : []
      if (planned) schedule(undefined)
      if (!root || (!planned && !stopped.length)) return output(`No ${name} run is scheduled in this Kinex.`)
      return output(`Stopped the ${name} run ${root}${stopped.length ? `: ${stopped.join(", ")} ended and count as abandoned` : ""}. /${name} resume continues it from what is finished.`)
    }
    const scheduled = current()
    if (scheduled?.root) throw new Error(`The ${scheduled.strategy} run ${scheduled.root} is already scheduled in this Kinex; /${scheduled.strategy} stop ends it`)
    if (first === "resume") {
      if (rest.length > 1) throw new Error(usage)
      const run = await openRun(await kinex(), name, rest[0])
      const prompt = await strategy.resume(run.root)
      schedule({ strategy: name, request: run.config.selection, root: run.root })
      return { kind: "workflow", prompt }
    }
    if (first === undefined) throw new Error(usage)
    // The session plans the run with the user; the strategy's plan tool makes it once the user has approved.
    const prompt = strategy.plan(args.trim())
    schedule({ strategy: name, request: args.trim() })
    return { kind: "workflow", prompt }
  }

  // What completes after a command: its subcommands, and what the strategy adds for the workspace's newest run.
  async function choices(strategy: Strategy): Promise<string[]> {
    if (currentRole()) return []
    const run = await openRun(await kinex(), strategy.name).catch(() => undefined)
    return ["status", "stop", "resume", ...await strategy.choices?.(run?.root) ?? []]
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
    // A strategy's context sections, such as an installed brief, are sent before the
    // first request, again only when they change and after compaction, never as part
    // of the stable prompt. One that is gone is sent empty once.
    context: () => runtime.operation(async () => {
      const sections: Record<string, string> = {}
      for (const strategy of STRATEGIES) for (const [section, text] of Object.entries(await strategy.context?.(runtime.directory) ?? {})) {
        if (text || given.has(section)) sections[section] = text
        if (text) given.add(section)
      }
      return { instructions: "", sections }
    }),
    commands: STRATEGIES.map(strategy => ({
      name: strategy.name, description: strategy.description, arguments: strategy.arguments, kind: "workflow" as const,
      choices: () => choices(strategy),
      execute: (args: string, context: CommandContext) => runtime.operation(() => execute(strategy, args, context), context.signal),
    })),
  }
}

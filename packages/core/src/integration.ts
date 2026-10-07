import type { KinexRuntime } from "./runtime.ts"
import { roboticsCommands, executeRoboticsCommand, type CommandContext, type CommandResult } from "./commands.ts"
import type { Context, Result } from "./tool/tool.ts"
import type { SkillInfo } from "./skill/index.ts"

export interface Invocation extends Context { callID?: string }
export interface ToolSchema { name: string; description: string; inputSchema: Record<string, unknown> }
export interface ContributionCommand {
  name: string
  description: string
  arguments: string
  kind: "operation" | "workflow"
  interrupt?: boolean
  choices?(): Promise<string[]>
  execute(args: string, context: CommandContext): Promise<CommandResult>
}
export interface KinexContribution {
  id: string
  tools?: {
    list(): Promise<{ tools: ToolSchema[]; problems: string[] }>
    call(name: string, input: unknown, invocation: Invocation): Promise<Result>
  }
  skills?: {
    list(): Promise<SkillInfo[]>
    load(name: string): Promise<{ info: SkillInfo; content: string } | undefined>
  }
  commands?: readonly ContributionCommand[]
  context?(): Promise<{ instructions: string; sections: Record<string, string> }>
}

/** Borrows the runtime. The product that created it owns initialization/disposal. */
export function coreContribution(runtime: KinexRuntime): KinexContribution {
  return {
    id: "core", tools: {
      list: () => runtime.tools.list(),
      call: (name, input, call) => runtime.tools.call(name, input, { sessionID: call.sessionID, callID: call.callID, signal: call.abort, ask: call.ask, questions: call.questions }),
    },
    skills: runtime.skills,
    commands: roboticsCommands.map(command => ({
      ...command, interrupt: command.name === "stop",
      choices: ["load", "unload", "reload", "ping", "stop", "unregister"].includes(command.name)
        ? async () => [...(await runtime.devices.list()).map(device => device.name), ...(["stop", "unregister"].includes(command.name) ? [] : ["all"])] : undefined,
      execute: (args, context) => executeRoboticsCommand(runtime, command.name, args, context),
    })),
    async context() {
      const context = await runtime.context()
      return { instructions: context.instructions, sections: {
        python: JSON.stringify(context.python), guides: context.guideRoots,
        conventions: context.conventions, skills: context.skills ?? "", recording: context.recording ?? "",
      } }
    },
  }
}

/** Explicit composition, not package discovery. Duplicate identifiers are errors. */
export function composeContributions(input: readonly KinexContribution[]) {
  const contributions = [...input].sort((a, b) => a.id.localeCompare(b.id))
  const ids = new Set<string>()
  const commands = new Map<string, ContributionCommand>()
  for (const source of contributions) {
    if (!/^[a-z][a-z0-9-]*$/.test(source.id) || ids.has(source.id)) throw new Error(`Invalid or duplicate contribution: ${source.id}`)
    ids.add(source.id)
    for (const command of source.commands ?? []) {
      if (commands.has(command.name)) throw new Error(`Duplicate command: ${command.name}`)
      commands.set(command.name, command)
    }
  }
  const catalog = async () => {
    const tools = new Map<string, { schema: ToolSchema; source: KinexContribution }>()
    const problems: string[] = []
    for (const source of contributions) {
      const loaded = await source.tools?.list()
      problems.push(...(loaded?.problems ?? []).map(problem => `${source.id}: ${problem}`))
      for (const schema of loaded?.tools ?? []) {
        if (tools.has(schema.name)) throw new Error(`Duplicate tool: ${schema.name}`)
        tools.set(schema.name, { schema, source })
      }
    }
    return { tools, problems: problems.sort() }
  }
  return {
    commands: [...commands.values()],
    tools: {
      async list() {
        const { tools, problems } = await catalog()
        return { tools: [...tools.values()].map(value => value.schema).sort((a, b) => a.name.localeCompare(b.name)), problems }
      },
      async call(name: string, input: unknown, invocation: Invocation) {
        invocation.abort.throwIfAborted()
        const item = (await catalog()).tools.get(name)
        if (!item?.source.tools) throw new Error(`Unknown Kinex tool: ${name}`)
        return item.source.tools.call(name, input, invocation)
      },
    },
    skills: {
      async list() {
        const entries = new Map<string, SkillInfo>()
        for (const source of contributions) for (const skill of await source.skills?.list() ?? []) {
          if (entries.has(skill.name)) throw new Error(`Duplicate skill: ${skill.name}`)
          entries.set(skill.name, skill)
        }
        return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name))
      },
      async load(name: string) {
        await this.list()
        for (const source of contributions) {
          const result = await source.skills?.load(name)
          if (result) return result
        }
      },
    },
    async context() {
      const instructions: string[] = []
      const sections: Record<string, string> = {}
      for (const source of contributions) {
        const context = await source.context?.()
        if (context?.instructions) instructions.push(context.instructions)
        for (const key of Object.keys(context?.sections ?? {}).sort()) sections[`${source.id}.${key}`] = context?.sections[key] ?? ""
        if (source.skills && context?.sections.skills === undefined) sections[`${source.id}.skills`] = JSON.stringify(await source.skills.list())
      }
      return { instructions: instructions.join("\n\n"), sections }
    },
  }
}
export type KinexCapabilities = ReturnType<typeof composeContributions>

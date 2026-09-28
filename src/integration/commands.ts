import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import type { ContributionCommand } from "@kinex/core/integration"

export async function executeCommand(command: ContributionCommand, args: string, ctx: ExtensionContext) {
  if (command.interrupt) ctx.abort()
  return command.execute(args, {
    sessionID: ctx.sessionManager.getSessionId(),
    signal: command.interrupt ? undefined : ctx.signal,
    confirm: async (title, description) => {
      if (!ctx.hasUI) return false
      const accepted = await ctx.ui.confirm(title, description, { signal: ctx.signal })
      ctx.signal?.throwIfAborted()
      return accepted
    },
    notify: message => { if (ctx.hasUI) ctx.ui.notify(message, "info") },
  })
}

export async function registerCommands(pi: ExtensionAPI, commands: readonly ContributionCommand[], execute: (name: string, args: string, ctx: ExtensionContext) => Promise<void>, bound = false) {
  const existing = new Set(bound ? pi.getCommands().map(command => command.name) : [])
  const choices = new Map<string, string[]>()
  const refresh = async () => {
    for (const command of commands) if (command.choices) choices.set(command.name, await command.choices())
  }
  pi.on("session_start", refresh)
  pi.on("agent_settled", refresh)
  for (const command of commands) {
    const register = (name: string) => pi.registerCommand(name, {
      description: `${command.description} ${command.arguments}`.trim(),
      getArgumentCompletions: prefix => choices.has(command.name) ? (choices.get(command.name) ?? []).filter(value => value.startsWith(prefix)).map(value => ({ value, label: value })) : null,
      handler: async (args, ctx) => { try { await execute(command.name, args, ctx) } finally { await refresh() } },
    })
    const alias = `kinex-${command.name}`
    if (existing.has(alias)) throw new Error(`Kinex command conflicts with ${alias}`)
    register(alias)
    if (command.name !== "reload" && !existing.has(command.name)) register(command.name)
  }
  await refresh()
}

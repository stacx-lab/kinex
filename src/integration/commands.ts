import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Loader, matchesKey } from "@earendil-works/pi-tui"
import type { CommandContext } from "@kinex/core"
import type { ContributionCommand } from "@kinex/core/integration"
import { commandRow } from "./render.ts"

/** What a command may ask of the application rather than of the session it was typed in. */
export type CommandHost = Required<Pick<CommandContext, "turn" | "unattended">>

export async function executeCommand(command: ContributionCommand, args: string, ctx: ExtensionContext, signal: AbortSignal | undefined, host: CommandHost) {
  if (command.interrupt) ctx.abort()
  return command.execute(args, {
    ...host,
    sessionID: ctx.sessionManager.getSessionId(),
    signal: command.interrupt ? undefined : signal,
    confirm: async (title, description) => {
      if (!ctx.hasUI) return false
      const accepted = await ctx.ui.confirm(title, description, { signal })
      signal?.throwIfAborted()
      return accepted
    },
    notify: message => { if (ctx.hasUI) ctx.ui.notify(message, "info") },
  })
}

/**
 * A user command while it runs: its pending row above the editor, and Escape to cancel it.
 * During an agent run Escape already ends the run, and the command with it.
 */
export function commandProgress(ctx: ExtensionContext, name: string, args: string) {
  const cancel = new AbortController()
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, cancel.signal]) : cancel.signal
  if (!ctx.hasUI) return { signal, cancelled: () => false, end() {} }
  const started = Date.now()
  // A command that answers at once would only flash its row.
  const shown = setTimeout(() => ctx.ui.setWidget("kinex-command", (tui, theme) => {
    const hint = ctx.signal ? "" : " · esc to cancel"
    const label = () => `${Math.floor((Date.now() - started) / 1000)} s${hint}`
    const loader = new Loader(tui, text => theme.fg("accent", text), text => theme.fg("muted", text), label())
    loader.setPaddingX(0)
    const tick = setInterval(() => loader.setMessage(label()), 1000)
    return Object.assign(commandRow({ name, args }, theme, { expanded: false, outputPad: 1, status: loader }), {
      dispose() { clearInterval(tick); loader.stop() },
    })
  }), 150)
  const release = ctx.signal ? undefined : ctx.ui.onTerminalInput(data => {
    if (!matchesKey(data, "escape")) return undefined
    cancel.abort(new Error("Cancelled by the user"))
    return { consume: true }
  })
  return {
    signal,
    cancelled: () => cancel.signal.aborted,
    end() { clearTimeout(shown); release?.(); ctx.ui.setWidget("kinex-command", undefined) },
  }
}

export async function registerCommands(pi: ExtensionAPI, commands: readonly ContributionCommand[], execute: (name: string, args: string, ctx: ExtensionContext) => Promise<void>) {
  const choices = new Map<string, string[]>()
  const refresh = async () => {
    for (const command of commands) if (command.choices) choices.set(command.name, await command.choices())
  }
  pi.on("session_start", refresh)
  pi.on("agent_settled", refresh)
  for (const command of commands) {
    pi.registerCommand(command.name, {
      description: `${command.description} ${command.arguments}`.trim(),
      getArgumentCompletions: prefix => choices.has(command.name) ? (choices.get(command.name) ?? []).filter(value => value.startsWith(prefix)).map(value => ({ value, label: value })) : null,
      handler: async (args, ctx) => { try { await execute(command.name, args, ctx) } finally { await refresh() } },
    })
  }
  await refresh()
}

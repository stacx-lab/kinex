import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import type { TerminalResult } from "@kinex/setup"

// The CLI owns SIGINT. While the TUI lends its terminal to sudo, route that
// signal to this operation instead of shutting down the application/runtime.
let terminalOperation: AbortController | undefined

export function cancelTerminalOperation(): boolean {
  if (!terminalOperation) return false
  terminalOperation.abort(new Error("System package installation cancelled; packages remain incomplete."))
  return true
}

export async function withTerminal<T>(ctx: ExtensionContext, request: { message: string; signal: AbortSignal }, action: (signal: AbortSignal) => Promise<T>): Promise<TerminalResult<T>> {
  request.signal.throwIfAborted()
  if (ctx.mode !== "tui" || !process.stdin.isTTY || !process.stdout.isTTY) return { status: "unavailable" }
  const outcome = await ctx.ui.custom<{ value: T } | { error: unknown }>(async (tui, _theme, _keys, done) => {
    const controller = new AbortController()
    terminalOperation = controller
    let result: { value: T } | { error: unknown }
    try {
      tui.stop()
      process.stdout.write(`\nKinex: ${request.message}\n`)
      result = { value: await action(AbortSignal.any([request.signal, controller.signal])) }
    } catch (error) { result = { error } }
    finally {
      terminalOperation = undefined
      tui.start()
      tui.requestRender(true)
    }
    done(result)
    return { render: () => [], invalidate: () => {} }
  })
  if ("error" in outcome) throw outcome.error
  return { status: "completed", value: outcome.value }
}

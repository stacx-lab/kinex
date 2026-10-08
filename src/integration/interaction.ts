import { setupPermissionDefaults, type SetupHost } from "@kinex/setup"
import { AsyncLocalStorage } from "node:async_hooks"
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { PermissionDeniedError, QuestionDeclinedError, kinexPermissionAction, loadPermissionRules, type RuntimeOptions, type Question } from "@kinex/core"

import { withTerminal } from "./terminal.ts"

export type Mode = "ask" | "auto" | "yolo"
export class Interaction {
  private calls = new AsyncLocalStorage<{ ctx: ExtensionContext; signal: AbortSignal }>()
  private lifetime = new AbortController()
  private queue: Promise<unknown> = Promise.resolve()
  private grants = new Set<string>()
  constructor(public mode: Mode) {}

  reset() {
    this.lifetime.abort(new Error("Session ended"))
    this.lifetime = new AbortController()
    this.grants.clear()
  }

  run<T>(ctx: ExtensionContext, signal: AbortSignal | undefined, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const combined = AbortSignal.any([this.lifetime.signal, ...(ctx.signal ? [ctx.signal] : []), ...(signal ? [signal] : [])])
    return this.calls.run({ ctx, signal: combined }, () => action(combined))
  }

  private current() {
    const call = this.calls.getStore()
    if (!call) throw new Error("Kinex interaction requires an active invocation")
    call.signal.throwIfAborted()
    return call
  }

  private dialog<T>(action: () => Promise<T>): Promise<T> {
    const { signal } = this.current()
    const pending = this.queue.then(() => { signal.throwIfAborted(); return action() })
    this.queue = pending.catch(() => {})
    return pending
  }

  readonly setupHost: SetupHost = {
    withTerminal: (request, action) => this.dialog(() => {
      const { ctx, signal } = this.current()
      return withTerminal(ctx, { ...request, signal: AbortSignal.any([signal, request.signal]) }, action)
    }),
  }

  readonly host: NonNullable<RuntimeOptions["host"]> = {
    ask: async request => {
      const { ctx, signal } = this.current()
      const key = `${ctx.sessionManager.getSessionId()}:${request.permission}`
      if (request.permission === "device_stop" || this.mode !== "ask" || this.grants.has(key)) return
      const action = kinexPermissionAction(request.permission, await loadPermissionRules(ctx.cwd), setupPermissionDefaults)
      if (action === "allow") return
      if (action === "ask" && ctx.hasUI) {
        const choice = await this.dialog(() => ctx.ui.select(`Kinex: ${request.permission}\n${request.description}`, ["Allow once", "Allow for this session", "Deny"], { signal }))
        signal.throwIfAborted()
        if (choice === "Allow for this session") this.grants.add(key)
        if (choice === "Allow once" || choice === "Allow for this session") return
      }
      throw new PermissionDeniedError(request.permission)
    },
    questions: async questions => this.questions(questions),
  }

  async questions(questions: Question[]): Promise<Record<string, string>> {
    const { ctx, signal } = this.current()
    if (this.mode === "yolo") return Object.fromEntries(questions.map(question => [question.question, "you are in yolo mode, process without answer, do not ask further questions, keep going until the task is solved."]))
    if (!ctx.hasUI) return Object.fromEntries(questions.map(question => [question.question, "No user answer is available. Use existing evidence and keep unknown facts unknown."]))
    const answers: Record<string, string> = {}
    for (const question of questions) {
      const choices = question.options.map(option => `${option.label}${option.description ? ` — ${option.description}` : ""}`)
      const answer = await this.dialog(async () => {
        if (question.multiple || !choices.length) return ctx.ui.input(`${question.header}: ${question.question}\n${choices.join("\n")}`, undefined, { signal })
        const selected = await ctx.ui.select(question.question, [...choices, "Write an answer"], { signal })
        if (selected === "Write an answer") return ctx.ui.input(question.question, undefined, { signal })
        return selected === undefined ? undefined : question.options[choices.indexOf(selected)]?.label
      })
      signal.throwIfAborted()
      if (answer === undefined) throw new QuestionDeclinedError()
      answers[question.question] = answer
    }
    return answers
  }
}

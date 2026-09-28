import { readFile } from "node:fs/promises"
import type { AgentSession } from "@earendil-works/pi-coding-agent"
import type { contextUpdate } from "./context.ts"

type ContextMessage = NonNullable<Awaited<ReturnType<typeof contextUpdate>>["message"]>

export interface CompactionControl {
  begin(signal: AbortSignal): void
  end(): void
  append(message: ContextMessage): void
  fail(error: Error): void
  recover(): Error | undefined
}

export async function createCompactionControl() {
  const instructions = await readFile(new URL("./compaction.txt", import.meta.url), "utf8")
  let signal: AbortSignal | undefined
  let session: AgentSession | undefined
  let failure: Error | undefined
  return {
    begin(current: AbortSignal) { signal = current },
    end() { signal = undefined },
    fail(error: Error) { failure = error },
    recover() { const previous = failure; failure = undefined; return previous },
    bind(current: AgentSession) {
      session = current
      const transform = current.agent.transformContext
      current.agent.transformContext = async (messages, abort) => {
        // A later prompt may also fail to read core state. Do not resume model
        // work until a successful snapshot refresh explicitly clears the failure.
        if (failure) throw failure
        return transform ? transform(messages, abort) : messages
      }
      const stream = current.agent.streamFunction
      current.agent.streamFunction = (model, context, options) => {
        // Scope the additional rules to Pi's summarization requests, including
        // split-turn summaries and retries. Normal conversation stays untouched.
        if (!signal || signal.aborted || options?.signal !== signal) return stream(model, context, options)
        const [first, ...rest] = context.messages
        const rule = { type: "text" as const, text: instructions }
        const messages = first?.role === "system"
          ? [{ ...first, content: typeof first.content === "string" ? `${first.content}\n\n${instructions}` : [...first.content, rule] }, ...rest]
          : [{ role: "system" as const, content: instructions, timestamp: 0 }, ...context.messages]
        return stream(model, { ...context, messages }, options)
      }
    },
    append(message: ContextMessage) {
      if (!session) throw new Error("Session is not initialized")
      // Only used at the committed compaction boundary: no tool batch is pending.
      // sendMessage(triggerTurn:false) would defer this until the next turn_end.
      session.sessionManager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details)
      session.refreshContext()
    },
  }
}

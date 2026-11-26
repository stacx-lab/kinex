import { readFile } from "node:fs/promises"
import {
  createAgentSession, DefaultResourceLoader, resolveCliModel, SessionManager, SettingsManager,
  type CreateAgentSessionOptions, type ModelRuntime,
} from "@earendil-works/pi-coding-agent"
import type { Subagent } from "@kinex/core"
import SYSTEM from "./subagent.txt"

type Model = NonNullable<CreateAgentSessionOptions["model"]>
type Thinking = NonNullable<CreateAgentSessionOptions["thinkingLevel"]>
const LEVELS: readonly Thinking[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]

function level(value: string | undefined): Thinking | undefined {
  const found = LEVELS.find(item => item === value)
  if (value !== undefined && !found) throw new Error(`Unknown thinking level ${value}; use ${LEVELS.join(", ")}`)
  return found
}

/**
 * Subagents for programs: each call is a Pi session of its own, without tools, on the
 * application's model runtime, so every provider and credential the user configured
 * for Kinex serves it. A call uses the session's model unless it names another.
 */
export function createSubagents(options: { modelRuntime: ModelRuntime; agentDir: string; directory(): string; sessionModel(): Model | undefined }): Subagent {
  const { modelRuntime, agentDir } = options
  const named = (reference: string): { model: Model; thinking?: Thinking } => {
    const resolved = resolveCliModel({ cliModel: reference, modelRuntime })
    if (!resolved.model) throw new Error(resolved.error ?? `Unknown model ${reference}`)
    return { model: resolved.model, thinking: resolved.thinkingLevel }
  }
  const name = (model: Model) => `${model.provider}/${model.id}`

  return async (request, signal) => {
    const chosen = request.model ? named(request.model) : undefined
    const model = chosen?.model ?? options.sessionModel()
    if (!model) throw new Error("No model for subagents: the session has none, and the call names none")
    const images = await Promise.all(request.show.flatMap(item => "image" in item
      ? [readFile(item.image.path, { signal }).then(data => ({ type: "image" as const, data: data.toString("base64"), mimeType: item.image.mime }))] : []))
    if (images.length && !model.input.includes("image")) throw new Error(`${name(model)} does not read images`)
    const shown = request.show.map(item => "image" in item ? `${item.name}: image ${request.show.filter(other => "image" in other).indexOf(item) + 1}` : `${item.name}: ${item.text}`)
    const cwd = options.directory()
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPromptOverride: () => SYSTEM.trim(), appendSystemPromptOverride: () => [],
    })
    await resourceLoader.reload()
    const { session } = await createAgentSession({
      cwd, agentDir, modelRuntime, model, noTools: "all", resourceLoader,
      thinkingLevel: level(request.thinking) ?? chosen?.thinking ?? "off",
      sessionManager: SessionManager.inMemory(cwd), settingsManager: SettingsManager.inMemory(),
    })
    const abort = () => { void session.abort() }
    signal.addEventListener("abort", abort, { once: true })
    try {
      signal.throwIfAborted()
      await session.prompt([request.instruction, ...(shown.length ? ["", ...shown] : [])].join("\n"), { images, expandPromptTemplates: false })
      signal.throwIfAborted()
      const last = session.messages.findLast(message => message.role === "assistant")
      if (last?.role === "assistant" && last.stopReason === "error") throw new Error(last.errorMessage ?? `${name(model)} returned an error`)
      const text = session.getLastAssistantText()
      if (!text?.trim()) throw new Error(`${name(model)} returned no text`)
      return { text, model: name(model) }
    } finally {
      signal.removeEventListener("abort", abort)
      session.dispose()
    }
  }
}

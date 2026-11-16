import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import {
  createAgentSession, DefaultResourceLoader, resolveCliModel, SessionManager, SettingsManager,
  type CreateAgentSessionOptions, type ModelRuntime,
} from "@earendil-works/pi-coding-agent"
import type { Subagent } from "@kinex/core"
import SYSTEM from "./subagent.txt"

type Model = NonNullable<CreateAgentSessionOptions["model"]>
type Thinking = NonNullable<CreateAgentSessionOptions["thinkingLevel"]>
const LEVELS: readonly Thinking[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
const USAGE = "Usage: /subagent [<provider/model> [thinking] | session]"

/** The model a program's subagents use unless a call names another. */
export interface SubagentSettings { model?: string; thinking?: Thinking }

function level(value: string | undefined): Thinking | undefined {
  const found = LEVELS.find(item => item === value)
  if (value !== undefined && !found) throw new Error(`Unknown thinking level ${value}; use ${LEVELS.join(", ")}`)
  return found
}

/**
 * Subagents for programs: each call is a Pi session of its own, without tools, on the
 * application's model runtime, so every provider and credential the user configured
 * for Kinex serves it.
 */
export function createSubagents(options: { modelRuntime: ModelRuntime; agentDir: string; file: string; directory(): string; sessionModel(): Model | undefined }) {
  const { modelRuntime, agentDir, file } = options
  const read = async (): Promise<SubagentSettings> => {
    const text = await readFile(file, "utf8").catch(() => "")
    if (!text.trim()) return {}
    const value: unknown = JSON.parse(text)
    const field = (name: string) => value && typeof value === "object" && typeof Reflect.get(value, name) === "string" ? String(Reflect.get(value, name)) : undefined
    return { model: field("model"), thinking: level(field("thinking")) }
  }
  const named = (reference: string): { model: Model; thinking?: Thinking } => {
    const resolved = resolveCliModel({ cliModel: reference, modelRuntime })
    if (!resolved.model) throw new Error(resolved.error ?? `Unknown model ${reference}`)
    return { model: resolved.model, thinking: resolved.thinkingLevel }
  }
  const name = (model: Model) => `${model.provider}/${model.id}`
  const describe = (settings: SubagentSettings) =>
    `Subagents use ${settings.model ?? "the session's model"}, thinking ${settings.thinking ?? "off"}.`

  const run: Subagent = async (request, signal) => {
    const settings = await read()
    const reference = request.model ?? settings.model
    const chosen = reference ? named(reference) : undefined
    const model = chosen?.model ?? options.sessionModel()
    if (!model) throw new Error("No model for subagents: choose one with /subagent <provider/model>")
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
      thinkingLevel: level(request.thinking) ?? (request.model ? chosen?.thinking : settings.thinking ?? chosen?.thinking) ?? "off",
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

  return {
    run,
    /** Models the user has credentials for, as provider/model. */
    models: async () => (await modelRuntime.getAvailable()).map(name).sort(),
    /** The /subagent command: show the setting, choose a model, or follow the session's model. */
    async configure(args: string): Promise<string> {
      const [reference, thinking, ...rest] = args.trim().split(/\s+/).filter(Boolean)
      if (rest.length) throw new Error(USAGE)
      if (!reference) return describe(await read())
      if (reference === "session" && thinking) throw new Error(USAGE)
      const chosen = reference === "session" ? undefined : named(reference)
      if (chosen && !modelRuntime.hasConfiguredAuth(chosen.model.provider)) throw new Error(`No credentials for ${chosen.model.provider}; sign in with /login or set its API key first`)
      const settings: SubagentSettings = chosen ? { model: name(chosen.model), thinking: level(thinking) ?? chosen.thinking ?? "off" } : {}
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, JSON.stringify(settings, null, 2) + "\n")
      return describe(settings)
    },
  }
}
export type Subagents = ReturnType<typeof createSubagents>

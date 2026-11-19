import { createKinexSetup, setupContribution, setupLibRoots, setupSkillRoots, setupToolNames } from "@kinex/setup"
import { selfImproveContribution, selfImproveToolNames } from "@kinex/self-improve"
import path from "node:path"
import {
  createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices,
  ModelRuntime, SessionManager, resolveCliModel, type AgentSessionRuntime, type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent"
import { paths, sessionDirectory, settings } from "./settings.ts"
import { prepareAuthPath } from "./auth.ts"
import { resolveSession } from "./sessions.ts"
import { RoboticsOwner } from "./integration/owner.ts"
import { createSubagents } from "./integration/subagent.ts"
import { kinexExtension, type MainSession } from "./integration/extension.ts"
import { createCompactionControl } from "./integration/compaction.ts"
import { defaultExtensionPaths } from "./integration/default-extensions.ts"
import type { Mode } from "./integration/interaction.ts"
import type { KinexRuntime } from "@kinex/core"
import { composeContributions, coreContribution, type KinexContribution } from "@kinex/core/integration"

export interface ApplicationComposition {
  builtinSkillRoots?: readonly string[]
  builtinLibRoots?: readonly string[]
  reservedToolNames?: readonly string[]
  contributions(runtime: KinexRuntime): readonly KinexContribution[]
}

const defaultComposition: ApplicationComposition = {
  builtinSkillRoots: setupSkillRoots, builtinLibRoots: setupLibRoots, reservedToolNames: [...setupToolNames, ...selfImproveToolNames],
  contributions: runtime => [coreContribution(runtime), setupContribution(createKinexSetup(runtime)), selfImproveContribution(runtime)],
}

export interface ApplicationOptions {
  cwd: string
  model?: string
  provider?: string
  thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"]
  mode?: Mode
  enableRecording?: boolean
  continue?: boolean
  session?: string
  report?: (text: string) => void
  composition?: ApplicationComposition
}

/**
 * The session in front of the user, as work that outlives one session reaches it.
 * A turn with a folder runs in a session of its own there, an empty file giving a
 * fresh one, the way opening a session of another workspace does: the workspace's
 * runtime and context are that folder's. The user's own session returns after.
 */
function mainSession(current: () => AgentSessionRuntime | undefined): MainSession {
  const runtime = () => {
    const host = current()
    if (!host) throw new Error("Session is not initialized")
    return host
  }
  const run = async (prompt: string, signal?: AbortSignal) => {
    const { session } = runtime()
    const abort = () => { void session.abort() }
    signal?.throwIfAborted()
    signal?.addEventListener("abort", abort, { once: true })
    try {
      await session.prompt(prompt, { expandPromptTemplates: false })
      await session.waitForIdle()
    } finally { signal?.removeEventListener("abort", abort) }
    signal?.throwIfAborted()
    const last = session.messages.findLast(message => message.role === "assistant")
    if (last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) throw new Error(last.errorMessage ?? `The turn was ${last.stopReason}`)
  }
  return {
    async turn(turn, signal) {
      await runtime().session.waitForIdle()
      if (!turn.session || !turn.directory) return run(turn.prompt, signal)
      const home = { file: runtime().session.sessionFile, cwd: runtime().cwd }
      if (!home.file) throw new Error("The session is not kept in a file, so it could not be returned to")
      try { await runtime().switchSession(turn.session, { cwdOverride: turn.directory, withSession: () => run(turn.prompt, signal) }) }
      finally { await runtime().switchSession(home.file, { cwdOverride: home.cwd }) }
    },
    post(text) {
      void runtime().session.sendCustomMessage({ customType: "kinex", content: text, display: true }, { triggerTurn: false })
    },
  }
}

export async function createApplication(options: ApplicationOptions) {
  const cwd = path.resolve(options.cwd)
  const storage = paths()
  if (options.provider && !options.model) throw new Error("--provider requires --model")
  const sessionPath = options.session ? await resolveSession(options.session, cwd) : undefined
  const authPath = await prepareAuthPath(storage.agent, storage.state)
  const { contributions, builtinSkillRoots = [], builtinLibRoots = [], reservedToolNames = [] } = options.composition ?? defaultComposition
  const owner = new RoboticsOwner(options.enableRecording ?? false, options.mode ?? "ask", {
    builtinSkillRoots: [...builtinSkillRoots],
    builtinLibRoots: [...builtinLibRoots],
    reservedToolNames: [...reservedToolNames],
  })
  const modelRuntime = await ModelRuntime.create({
    authPath, modelsPath: path.join(storage.agent, "models.json"),
    modelsStorePath: path.join(storage.state, "models-cache.json"), allowModelNetwork: false,
  })
  owner.subagents = createSubagents({
    modelRuntime, agentDir: storage.agent, file: path.join(storage.config, "subagent.json"),
    directory: () => owner.runtime?.directory ?? cwd, sessionModel: () => owner.model,
  })
  const sessionDir = sessionDirectory(cwd)
  const main = mainSession(() => host)
  const manager = sessionPath ? SessionManager.open(sessionPath, sessionDir)
    : options.continue ? SessionManager.continueRecent(cwd, sessionDir) : SessionManager.create(cwd, sessionDir)
  let host: AgentSessionRuntime | undefined
  try {
    host = await createAgentSessionRuntime(async ({ cwd: directory, sessionManager, sessionStartEvent }) => {
      const core = await owner.enter(directory)
      const capabilities = composeContributions(contributions(core))
      const settingsManager = settings(directory)
      const compaction = await createCompactionControl()
      let submitWorkflow = async (_prompt: string): Promise<void> => { throw new Error("Session is not initialized") }
      let settle = async (): Promise<void> => {}
      const services = await createAgentSessionServices({
        cwd: directory, agentDir: storage.agent, modelRuntime, settingsManager,
        resourceLoaderOptions: {
          additionalExtensionPaths: defaultExtensionPaths(settingsManager),
          noExtensions: false, noSkills: false, noPromptTemplates: false, noThemes: false,
          systemPrompt: "", appendSystemPrompt: [],
          extensionFactories: [{ name: "kinex", factory: kinexExtension(owner, core, capabilities, options.report ?? (() => {}), {
            prompt: prompt => submitWorkflow(prompt), settle: () => settle(), compaction,
          }, main), hidden: true }],
        },
      })
      const errors = services.resourceLoader.getExtensions().errors
      if (errors.length) throw new Error(errors.map(error => `${error.path}: ${error.error}`).join("\n"))
      const settingsErrors = settingsManager.drainErrors()
      if (settingsErrors.length) throw new Error(settingsErrors.map(error => String(error.error)).join("\n"))
      const resolved = resolveCliModel({ cliProvider: options.provider, cliModel: options.model, cliThinking: options.thinkingLevel, modelRuntime })
      if (resolved.error) throw new Error(resolved.error)
      if (resolved.warning) console.error(`Kinex: ${resolved.warning}`)
      const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent,
        model: resolved.model, thinkingLevel: options.thinkingLevel ?? resolved.thinkingLevel })
      compaction.bind(result.session)
      submitWorkflow = prompt => result.session.sendUserMessage(prompt, { deliverAs: "followUp" })
      settle = async () => { await result.session.abort(); await settingsManager.flush() }
      return { ...result, services, diagnostics: services.diagnostics }
    }, { cwd: manager.getCwd(), agentDir: storage.agent, sessionManager: manager })
    const runtime = host
    let disposed: Promise<void> | undefined
    return {
      host: runtime, owner, main,
      dispose(): Promise<void> {
        return disposed ??= (async () => {
          try { await runtime.session.abort(); await runtime.dispose() }
          finally { await owner.dispose(); await runtime.services.settingsManager.flush() }
        })()
      },
    }
  } catch (error) { await owner.dispose(); throw error }
}

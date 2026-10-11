import { createKinexSetup, setupContribution, setupSkillRoots, setupToolNames } from "@kinex/setup"
import { existsSync } from "node:fs"
import path from "node:path"
import {
  createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices,
  ModelRuntime, SessionManager, type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent"
import { paths, sessionDirectory, settings } from "./settings.ts"
import { prepareAuthPath } from "./auth.ts"
import { RoboticsOwner } from "./integration/owner.ts"
import { kinexExtension } from "./integration/extension.ts"
import { createCompactionControl } from "./integration/compaction.ts"
import { defaultExtensionPaths } from "./integration/default-extensions.ts"
import type { Mode } from "./integration/interaction.ts"
import type { KinexRuntime } from "@kinex/core"
import { composeContributions, coreContribution, type KinexContribution } from "@kinex/core/integration"

export interface ApplicationComposition {
  builtinSkillRoots?: readonly string[]
  reservedToolNames?: readonly string[]
  contributions(runtime: KinexRuntime): readonly KinexContribution[]
}

const defaultComposition: ApplicationComposition = {
  builtinSkillRoots: setupSkillRoots, reservedToolNames: setupToolNames,
  contributions: runtime => [coreContribution(runtime), setupContribution(createKinexSetup(runtime))],
}

export interface ApplicationOptions {
  cwd: string
  model?: string
  thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"]
  mode?: Mode
  enableRecording?: boolean
  continue?: boolean
  session?: string
  report?: (text: string) => void
  composition?: ApplicationComposition
}

export async function createApplication(options: ApplicationOptions) {
  const cwd = path.resolve(options.cwd)
  const storage = paths()
  const authPath = await prepareAuthPath(storage.agent, storage.state)
  const { contributions, builtinSkillRoots = [], reservedToolNames = [] } = options.composition ?? defaultComposition
  const owner = new RoboticsOwner(options.enableRecording ?? false, options.mode ?? "ask", {
    builtinSkillRoots: [...builtinSkillRoots],
    reservedToolNames: [...reservedToolNames],
  })
  const modelRuntime = await ModelRuntime.create({
    authPath, modelsPath: path.join(storage.agent, "models.json"),
    modelsStorePath: path.join(storage.state, "models-cache.json"), allowModelNetwork: false,
  })
  const sessionDir = sessionDirectory(cwd)
  const sessionPath = options.session
    ? (existsSync(options.session) ? path.resolve(options.session) : SessionManager.findById(cwd, options.session, sessionDir))
    : undefined
  if (options.session && !sessionPath) throw new Error(`Unknown Kinex session: ${options.session}`)
  const manager = sessionPath ? SessionManager.open(sessionPath, sessionDir)
    : options.continue ? SessionManager.continueRecent(cwd, sessionDir) : SessionManager.create(cwd, sessionDir)
  try {
    const host = await createAgentSessionRuntime(async ({ cwd: directory, sessionManager, sessionStartEvent }) => {
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
          }), hidden: true }],
        },
      })
      const errors = services.resourceLoader.getExtensions().errors
      if (errors.length) throw new Error(errors.map(error => `${error.path}: ${error.error}`).join("\n"))
      const settingsErrors = settingsManager.drainErrors()
      if (settingsErrors.length) throw new Error(settingsErrors.map(error => String(error.error)).join("\n"))
      const slash = options.model?.indexOf("/") ?? -1
      const model = options.model && slash > 0 ? modelRuntime.getModel(options.model.slice(0, slash), options.model.slice(slash + 1)) : undefined
      if (options.model && !model) throw new Error(`Unknown model ${options.model}; use provider/model and configure agent/models.json if needed`)
      const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model, thinkingLevel: options.thinkingLevel })
      compaction.bind(result.session)
      submitWorkflow = prompt => result.session.sendUserMessage(prompt, { deliverAs: "followUp" })
      settle = async () => { await result.session.abort(); await settingsManager.flush() }
      return { ...result, services, diagnostics: services.diagnostics }
    }, { cwd: manager.getCwd(), agentDir: storage.agent, sessionManager: manager })
    let disposed: Promise<void> | undefined
    return {
      host, owner,
      dispose(): Promise<void> {
        return disposed ??= (async () => {
          try { await host.session.abort(); await host.dispose() }
          finally { await owner.dispose(); await host.services.settingsManager.flush() }
        })()
      },
    }
  } catch (error) { await owner.dispose(); throw error }
}

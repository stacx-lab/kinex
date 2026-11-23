import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Global } from "@kinex/core/global"
import { kinex, modelFlags } from "./kinex.ts"
import { kinexFile, writeJson } from "./layout.ts"
import type { Run } from "./run.ts"

// A trial and a distillation each run as a background sub-agent of pi-subagents,
// which starts them, shows them, stops them and tells the session when they end.
// What such a sub-agent runs is a command, this package's own (main.ts), named
// in an agent file in Kinex's agent folder. The files say nothing of a run: the
// call names the job with its run, so every Kinex that schedules a run shares them.
export const TRIAL_AGENT = "self-improve-trial"
export const DISTILL_AGENT = "self-improve-distill"

export const agentsDir = () => path.join(Global.Path.config, "agent", "agents")

/** The Kinex a run's children are, as the run's folder keeps it. */
export interface Scheduler { entry: string; flags: string[] }

// A job ends itself at its run's limits (main.ts); pi-subagents' own deadline for an agent is kept out of its way.
const BACKSTOP_MS = 7 * 24 * 3600 * 1000

function agentFile(name: string, description: string, kind: "trial" | "distill"): string {
  // A JSON string is a YAML string.
  return `---
name: ${name}
description: ${JSON.stringify(description)}
runner:
  type: external-cli
  command: ${JSON.stringify(process.execPath)}
  args: ${JSON.stringify([fileURLToPath(new URL("./main.ts", import.meta.url)), kind])}
  promptDelivery: stdin
async: true
timeoutMs: ${BACKSTOP_MS}
---
${description}
`
}

/**
 * Names the commands that do a run's jobs, for the sub-agent calls improve_next asks for,
 * and leaves in the run's folder which Kinex schedules it now: its children are that Kinex,
 * on the model it was started with.
 */
export async function writeAgents(run: Run): Promise<void> {
  if (!kinex.entry) throw new Error("Cannot locate the running Kinex entry point")
  const scheduler: Scheduler = { entry: kinex.entry, flags: modelFlags() }
  await writeJson(kinexFile(run.root), scheduler)
  await mkdir(agentsDir(), { recursive: true })
  await writeFile(path.join(agentsDir(), `${TRIAL_AGENT}.md`), agentFile(TRIAL_AGENT,
    "Runs one trial of a self-improve run. Start it only as improve_next says, with the task it names.", "trial"))
  await writeFile(path.join(agentsDir(), `${DISTILL_AGENT}.md`), agentFile(DISTILL_AGENT,
    "Runs one distillation of a self-improve run. Start it only as improve_next says, with the task it names.", "distill"))
}

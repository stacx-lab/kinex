import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Global } from "@kinex/core/global"
import { kinex, modelFlags } from "./kinex.ts"
import { schedulerFile, writeJson } from "./layout.ts"

// A strategy's job, such as a trial or a distillation, runs as a background
// sub-agent of pi-subagents, which starts it, shows it, stops it and tells the
// session when it ends. What such a sub-agent runs is a command, this package's
// own (main.ts) with the strategy and the kind of job, named in an agent file in
// Kinex's agent folder. The files say nothing of a run: the call names the run,
// so every Kinex that schedules a run shares them.

export const agentsDir = () => path.join(Global.Path.config, "agent", "agents")

/** The agent a strategy's jobs of one kind run as: `<strategy>-<kind>`. */
export const agentName = (strategy: string, kind: string) => `${strategy}-${kind}`

/** The Kinex a run's children are, as the run's folder keeps it. */
export interface Scheduler { entry: string; flags: string[] }

// A job ends itself at its run's limits (main.ts); pi-subagents' own deadline for an agent is kept out of its way.
const BACKSTOP_MS = 7 * 24 * 3600 * 1000

function agentFile(name: string, description: string, strategy: string, kind: string): string {
  // A JSON string is a YAML string.
  return `---
name: ${name}
description: ${JSON.stringify(description)}
runner:
  type: external-cli
  command: ${JSON.stringify(process.execPath)}
  args: ${JSON.stringify([fileURLToPath(new URL("../main.ts", import.meta.url)), strategy, kind])}
  promptDelivery: stdin
async: true
timeoutMs: ${BACKSTOP_MS}
---
${description}
`
}

/**
 * Names the commands that do a strategy's jobs, one agent per kind with its description, for the sub-agent calls
 * its scheduler gives, and leaves in the run's folder which Kinex schedules the run now: its children are that
 * Kinex, on the model it was started with.
 */
export async function writeAgents(root: string, strategy: string, kinds: Record<string, string>): Promise<void> {
  if (!kinex.entry) throw new Error("Cannot locate the running Kinex entry point")
  const scheduler: Scheduler = { entry: kinex.entry, flags: modelFlags() }
  await writeJson(schedulerFile(root), scheduler)
  await mkdir(agentsDir(), { recursive: true })
  for (const [kind, description] of Object.entries(kinds))
    await writeFile(path.join(agentsDir(), `${agentName(strategy, kind)}.md`), agentFile(agentName(strategy, kind), description, strategy, kind))
}

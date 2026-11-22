import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Global } from "@kinex/core/global"
import { kinex, modelFlags } from "./kinex.ts"
import { REPAIRS, REPAIR_S, type Run } from "./run.ts"

// A trial and a distillation each run as a background sub-agent of pi-subagents,
// which starts them, shows them, stops them and tells the session when they end.
// What such a sub-agent runs is a command, this package's own (main.ts), named
// in an agent file in Kinex's agent folder. The files are written for the run
// that is scheduled, so there is one run at a time.
export const TRIAL_AGENT = "self-improve-trial"
export const DISTILL_AGENT = "self-improve-distill"

export const agentsDir = () => path.join(Global.Path.config, "agent", "agents")

// What a job's process may take beyond its session: launching a simulator, a first build of the shared Python environment, records.
const SLACK_S = 3600

function agentFile(name: string, description: string, kind: "trial" | "distill", run: Run, timeoutS: number): string {
  if (!kinex.entry) throw new Error("Cannot locate the running Kinex entry point")
  const args = [fileURLToPath(new URL("./main.ts", import.meta.url)), kind, run.root, kinex.entry, ...modelFlags()]
  // A JSON string is a YAML string.
  return `---
name: ${name}
description: ${JSON.stringify(description)}
runner:
  type: external-cli
  command: ${JSON.stringify(process.execPath)}
  args: ${JSON.stringify(args)}
  promptDelivery: stdin
async: true
timeoutMs: ${(timeoutS + SLACK_S) * 1000}
---
${description}
`
}

/** Names the commands that do the run's jobs, for the sub-agent calls improve_next asks for. */
export async function writeAgents(run: Run): Promise<void> {
  await mkdir(agentsDir(), { recursive: true })
  await writeFile(path.join(agentsDir(), `${TRIAL_AGENT}.md`), agentFile(TRIAL_AGENT,
    "Runs one trial of the self-improve run scheduled in this Kinex. Start it only as improve_next says.", "trial", run, run.config.trialTimeoutS))
  await writeFile(path.join(agentsDir(), `${DISTILL_AGENT}.md`), agentFile(DISTILL_AGENT,
    "Runs one distillation of the self-improve run scheduled in this Kinex. Start it only as improve_next says.", "distill", run,
    run.config.distillTimeoutS + REPAIRS * REPAIR_S))
}

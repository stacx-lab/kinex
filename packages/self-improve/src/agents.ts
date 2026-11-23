import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Global } from "@kinex/core/global"
import { kinex, modelFlags } from "./kinex.ts"
import { kinexFile, waveScript, writeJson } from "./layout.ts"
import type { Run } from "./run.ts"

// A trial and a distillation each run as a background sub-agent of pi-subagents,
// which starts them, shows them, stops them and tells the session when they end.
// What such a sub-agent runs is a command, this package's own (main.ts), named
// in an agent file in Kinex's agent folder. The files say nothing of a run: the
// call names the run, so every Kinex that schedules a run shares them.
export const TRIAL_AGENT = "self-improve-trial"
export const DISTILL_AGENT = "self-improve-distill"

export const agentsDir = () => path.join(Global.Path.config, "agent", "agents")

// A wave's trials start together as one workflow of pi-subagents, which runs as many at a
// time as the call allows and tells the session once, when all have ended. The call's
// arguments are the session's to give: the tasks improve_next named and the library
// version their workers get. Each trial is told them as words on its standard input.
const WAVE = `const key = (task, index) => (index + 1) + "-" + task.replace(/[^A-Za-z0-9._-]+/g, "-").slice(-40);
await runs.all(args.tasks.map((task, index) => ({
  key: key(task, index), agent: "${TRIAL_AGENT}",
  task: "run=" + args.run + " task=" + task + (args.library ? " library=" + args.library : ""),
})));
return "The wave's trials have ended; each says above how. Call improve_next.";
`

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
 * Names the commands that do a run's jobs, for the sub-agent calls improve_next gives,
 * and leaves in the run's folder the workflow that starts a wave and which Kinex schedules
 * the run now: its children are that Kinex, on the model it was started with.
 */
export async function writeAgents(run: Run): Promise<void> {
  if (!kinex.entry) throw new Error("Cannot locate the running Kinex entry point")
  const scheduler: Scheduler = { entry: kinex.entry, flags: modelFlags() }
  await writeJson(kinexFile(run.root), scheduler)
  await writeFile(waveScript(run.root), WAVE)
  await mkdir(agentsDir(), { recursive: true })
  await writeFile(path.join(agentsDir(), `${TRIAL_AGENT}.md`), agentFile(TRIAL_AGENT,
    "Runs one trial of a self-improve run. Start it only with the call improve_next gives.", "trial"))
  await writeFile(path.join(agentsDir(), `${DISTILL_AGENT}.md`), agentFile(DISTILL_AGENT,
    "Runs one distillation of a self-improve run. Start it only with the call improve_next gives.", "distill"))
}

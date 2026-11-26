import { writeFile } from "node:fs/promises"
import { writeAgents as writeAgentFiles } from "../../common/agents.ts"
import { waveScript } from "./layout.ts"
import { DISTILL, NEXT, STRATEGY, TRIAL, TRIAL_AGENT } from "./names.ts"

// A wave's trials start together as one workflow of pi-subagents, which runs as many at a
// time as the call allows and tells the session once, when all have ended. The call's
// arguments are the session's to give: the tasks skill_next named and the library
// version their workers get. Each trial is told them as words on its standard input;
// the run's folder is a JSON string where it holds a space or a quote.
const WAVE = `const key = (task, index) => (index + 1) + "-" + task.replace(/[^A-Za-z0-9._-]+/g, "-").slice(-40);
const word = value => /^[^\\s"'\`\\\\]+$/.test(value) ? value : JSON.stringify(value);
await runs.all(args.tasks.map((task, index) => ({
  key: key(task, index), agent: "${TRIAL_AGENT}",
  task: "run=" + word(args.run) + " task=" + task + (args.library ? " library=" + args.library : ""),
})));
return "The wave's trials have ended; each says above how. Call ${NEXT}.";
`

/** The agents a run's trials and distillations run as, and the workflow that starts a wave, in the run's folder. */
export async function writeAgents(root: string): Promise<void> {
  await writeAgentFiles(root, STRATEGY, {
    [TRIAL]: `Runs one trial of a ${STRATEGY} run. Start it only with the call ${NEXT} gives.`,
    [DISTILL]: `Runs one distillation of a ${STRATEGY} run. Start it only with the call ${NEXT} gives.`,
  })
  await writeFile(waveScript(root), WAVE)
}

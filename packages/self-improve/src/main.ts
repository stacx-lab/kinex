import path from "node:path"
import { text } from "node:stream/consumers"
import { createScope, inScope, withSignal } from "@kinex/core/scope"
import type { Scheduler } from "./common/agents.ts"
import { heartbeat } from "./common/heartbeat.ts"
import { readJson, schedulerFile, strategyOf } from "./common/layout.ts"
import { kinex } from "./common/kinex.ts"
import { openRunAt } from "./common/run.ts"
import { Refused } from "./common/schedule.ts"
import { strategyNamed } from "./strategies/index.ts"

// The process of one job: a background sub-agent the session started runs this
// command, which has its strategy do the job its call names and says in a line
// how it ended. What it prints is what the session that started it is told;
// while it works it writes newlines to standard error, so that pi-subagents sees
// it at work (common/heartbeat.ts).
//   node main.js <strategy> <kind>, with the call's words on standard input:
//   run=<run folder> and the words the kind names, such as task=<task>
// A value is a word, or a JSON string where it holds a space or a quote.
const [name = "", kind = ""] = process.argv.slice(2)
const strategy = strategyNamed(name)
const job = strategy?.jobs[kind]
if (!strategy || !job) throw new Error("Usage: main.js <strategy> <kind>, with run=<run folder> and the job's own words on standard input")
const { next } = strategy
const { what, words: named = [], run: work } = job

const message = (error: unknown) => error instanceof Error ? error.message : String(error)

// What a job's process may take beyond its session: launching a simulator, a first build of the shared Python environment, records.
const SLACK_S = 3600

/** What the call says: the words on standard input that the job names, where the last word of a name counts. */
function said(input: string): Record<string, string> {
  const names = ["run", ...named].join("|")
  const value = (written: string) => written.startsWith('"') ? JSON.parse(written) as string : written
  return Object.fromEntries([...input.matchAll(new RegExp(`\\b(${names})=("(?:[^"\\\\]|\\\\.)*"|[^\\s"'\`]+)`, "g"))].map(([, word, written]) => [word, value(written!)]))
}

// Stopping the sub-agent, the strategy's stop and the job's own deadline all end
// the job the same way: its children are stopped, its simulator is closed, and it
// leaves no result, so it counts as abandoned, not failed.
async function main(): Promise<void> {
  const words = said(await text(process.stdin))
  const root = words.run && path.isAbsolute(words.run) && strategyOf(words.run) === name ? words.run : undefined
  const run = root && await openRunAt(root).catch(() => undefined)
  const scheduler = run && await readJson<Scheduler>(schedulerFile(run.root))
  if (!run || !scheduler) {
    console.log(`No ${name} run is named. Start this sub-agent only with the call ${next} gives. Call ${next}.`)
    return
  }
  kinex.entry = scheduler.entry
  kinex.args = scheduler.flags
  const abort = new AbortController()
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => abort.abort(new Error("The job was stopped")))
  const stopBeat = heartbeat(text => process.stderr.write(text))
  let deadline: NodeJS.Timeout | undefined
  const within = (seconds: number) => { deadline = setTimeout(() => abort.abort(new Error("The job ran past its deadline")), (seconds + SLACK_S) * 1000) }
  const scope = createScope(run.config.libRoots ? { builtinLibRoots: run.config.libRoots } : {})
  scope.signal = abort.signal
  try {
    console.log(await inScope(scope, () => withSignal(abort.signal, () => work({ root: run.root, words, signal: abort.signal, within }))))
  } catch (error) {
    // A job the scheduler does not have to do is an answer, not a failure of the sub-agent.
    if (error instanceof Refused) { console.log(`Not started: ${error.message}. Call ${next}.`); return }
    console.log(abort.signal.aborted ? `The ${what} was stopped and left no result. Call ${next}.` : `The ${what} failed: ${message(error)}. Call ${next}.`)
    process.exitCode = 1
  } finally {
    stopBeat()
    clearTimeout(deadline)
    scope.closed = true
  }
}
await main()

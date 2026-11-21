# @kinex/jobs

Start long work without blocking, queue it in lanes and collect it with one wait.
The package knows no agent host and imports only Node, so any tool author can use
it. Requires Node >=22.19.

- **Starting returns at once.** The caller gets a card with the job's id; the work
  runs outside its turn.
- **A job is a function.** A sub-agent is one kind of function, an API call another.
- **A lane is a limit and a queue.** Jobs of any kind share a lane; starting more
  than its limit waits in line.
- **The record holds the result.** The caller receives a card: one line and where
  the record is.
- **The caller collects with one wait.** It blocks until all or any have ended, and
  never polls.
- **Every job has an owner.** Whoever created the jobs lists them and stops them.

## From code

```ts
import { createJobs, line } from "@kinex/jobs"

const jobs = createJobs({ limits: { trials: 4 } })

jobs.start({ id: "t003", lane: "trials", record: "trials/t003/record",
             run: signal => runTrial(input, signal) })    // returns at once
const cards = await jobs.wait()                             // every job not yet ended
console.log(cards.map(line).join("\n"))                     // t003 done · success, 41 steps · record: trials/t003/record

jobs.list()        // queued, running, ended: one card each
jobs.stop("t003")  // aborts its signal; jobs.stop() stops them all
```

`run` resolves to `{ status?, summary? }` or nothing. A job that ends normally is
`done` unless it names another status, one that throws is `error` with the message
as its summary, and one that was stopped is `stopped`. `wait(ids, { mode, timeoutS,
signal })` returns the cards as they are when all (or, with `mode: "any"`, one) of
the jobs have ended or the time is up; the signal ends the wait, never the jobs.
`onEnd(card)` is called once for every job that ends, for a host that tells its
caller of an end instead of being asked.

## For a model

```ts
import { startTool, tools } from "@kinex/jobs/tools"

const run = startTool(jobs, {
  name: "sim_run", description: "Start one simulation.", lane: "sims",
  parameters: { type: "object", properties: { task: { type: "string" } }, required: ["task"] },
  job: args => ({ id: nextId(), record: recordOf(args.task), run: signal => simulate(args.task, signal) }),
})
const { wait, status, stop } = tools(jobs, { prefix: "sim" })   // sim_wait, sim_status, sim_stop
```

A tool is a plain definition: `name`, `description`, the JSON Schema of its
arguments as `parameters`, and `execute(args, signal)`, which resolves to
`{ title, text, isError? }`. A host registers it in its own way and validates the
arguments against the schema. `startTool` turns one kind of work into a tool that
returns an id at once; the wait tool returns one line per job when it has ended.

## Development

`node --test packages/jobs/test/*.test.mjs` after a build; `architecture.test.mjs`
keeps the package free of every import but Node's.

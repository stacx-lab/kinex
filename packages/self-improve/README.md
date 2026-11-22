# @kinex/self-improve

Lets Kinex practise simulated robot tasks, learn from its own attempts and keep
what it learned as ordinary Kinex skills, `kinex.lib` modules and programs. Requires Node >=22.19, an
aligned `@kinex/core` version and a prepared
[rosbridge](https://github.com/stacx-lab/rosbridge), as for any simulated work,
and on Linux [bubblewrap](https://github.com/containers/bubblewrap) with
unprivileged user namespaces to sandbox workers.

```text
/self-improve robocasa/add-ice-cubes robocasa/adjust-heat     named tasks
/self-improve libero/libero-spatial-* --rounds 3              a group, three rounds
/self-improve robocasa/* --rounds 6 --batches 10,20,40        open 10 tasks, then 20 more, 40 more, then the rest
/self-improve ten RoboCasa tasks about doors --parallel 2     free text, two trials at a time
/self-improve status [run]                                    no model: jobs, solved tasks per version
/self-improve install L2 [run]                                no model: copy L2 into this workspace
/self-improve resume [run]                                    continue a run from what is on disk
/self-improve stop                                            no model: end the run scheduled in this Kinex
```

One round is a wave of trials followed by one distillation. Code schedules a run;
the session that typed the command distills it. Start Kinex with `--auto`, or type
`/mode auto` first: a distillation edits files and runs commands with nobody to
approve them, so in `ask` mode the command offers to switch and otherwise does not
start.

| Role | Is | Package tools |
| --- | --- | --- |
| Scheduler | A loop in code in the Kinex process, `src/scheduler.ts` | none: it is not a model |
| Distiller | The main session, for one turn per distillation, in a session of its own rooted in the distillation's folder | `improve_delegate`, `improve_wait`, `improve_check` |
| Worker | A headless child session, one per trial, in a fresh rig workspace with one library version installed | none |
| Helper | A headless child session a distiller starts with a prompt it writes | none |

The scheduler reads the run's folder, starts one trial for every open task still
unsolved, and when the wave has ended gives the main session a turn to distill
it; then the next wave runs with the new version. With `--batches` tasks open a
batch a wave, in the order the last distiller asked for (`schedule.json`). It
stops when every task is solved, the rounds are done, or a round neither solved
a task nor published a version and no task is left to open. What fails is tried
again first: a trial that did not run (a setup problem, not a task failure) is
started again up to twice and its task then sits the wave out; a candidate that
fails the check gets up to two repair turns; a distillation whose turn did not
end normally is run again up to twice. While trials
run the session is free; for a distillation Kinex opens an empty session in that
distillation's folder, and the user's conversation returns when the turn ends.

A request made only of task ids or patterns is matched against rosbridge's
catalog in code. Anything else is free text: the main session converts it in one
short turn, looking tasks up with `improve_tasks` and saving them with
`improve_select`. The tasks are then fixed for the run (`tasks` in `config.json`),
all on one robot.

A **trial** is one episode of one task: `rosbridge launch` (stepped, ending where the
simulator's evaluator ends an episode, `--early-stop`), `rosbridge setup` of the same task and seed into the trial workspace
on the launched ROS domain, the library installed, one worker, then `rosbridge stop`
and `rosbridge judge`. The simulator's verdict decides; the worker's report never
counts. A **distillation** gives the distiller every finished trial's record and the
newest library, and publishes its candidate as the next version when its turn
ended normally and `improve_check` finds the candidate loadable, its Python
compiling and its skills naming only what its code defines. The distill prompts are rsi's distill-lean
prompts with the edits this design forces (one episode per trial, waves, folder
names, the check and sub-agents as tools, task skills instead of task briefs,
code as `kinex.lib` modules instead of a skill's body).

Trials and helpers are [jobs](#jobs): starting one returns at once, a lane runs
up to its limit and queues the rest, and one wait collects them. The scheduler
calls them from code; a distiller reaches them through `improve_delegate` and
`improve_wait`.

## Files

A run keeps everything under `<Kinex data directory>/self-improve/<run>/`, outside
every workspace so that no workspace's `.kinex` leaks into a trial.

```text
config.json                 the request, rounds, parallel, batches, limits, the rosbridge command
libraries/L0, L1, ...       published versions; never edited, the newest is current
  manifest.json             version, parent, the distillation it came from
  payload/                  what ships: skills/  tools/  lib/  programs/  brief.md
  memory/                   the distiller's notes for later distillations; never ships
trials/t001/
  input.json                task, robot, library version, limits
  workspace/                the rig export with the library installed
  record/                   prompt.md  session.jsonl  output.log  result.json
                            summary.md  history.md  history.json  images/   the transcript, in brief and in full
                            learned.md  learned/    what the worker kept beyond the library
distillations/d001/
  input.json                base version, trial ids, which of them are new
  workspace/                records/  reference/  library/ (the candidate)  notes/  schedule.json (the order of new tasks)
  record/                   prompt.md  session.jsonl (the distiller's own session)  result.json
                            helpers/<name>/  each as a trial's record
```

- A job is finished when its `record/result.json` exists. State is read by scanning
  these folders; no file is shared between running jobs.
- `payload/` uses Kinex's folder names, so installing is a copy into
  `.kinex/skills`, `.kinex/tools`, `.kinex/lib` and `.kinex/programs`; a `lib/`
  module named like a builtin `kinex.lib` module never ships. The brief goes to
  `.kinex/self-improve/brief.md`, and this package's context gives an installed
  brief to every session in that workspace as a context section, so installing
  or editing it leaves the stable prompt unchanged. A published brief has at most
  15 lines and 2,000 characters. A trial workspace
  is prepared by the same copy, so a worker sees a library exactly as a user who
  installed it. Install stops on a name that already exists.
- `session.jsonl` is a Kinex session file, a child's or the distiller's; `kinex --export` renders it.

## Limits

- A run belongs to the Kinex process that schedules it, not to a session or a
  workspace, and one run is scheduled at a time. `/self-improve stop` and quitting
  end its work: running workers and helpers are stopped and their simulators
  closed. A job left without a result is abandoned, its task is simply still
  unsolved, and `resume` continues from finished jobs.
- A distillation takes the session when it is idle and returns the user's own
  session after. The distiller works under the session's permission mode, which
  must be `auto` or `yolo`; in `auto`, a question it asks waits for the user.
- Headless, `kinex run --auto "/self-improve ..."` returns when the run has ended.
- Workers keep network access. The numbers show whether a library helps; they
  are not benchmark results.
- The check guarantees that a library loads and that its code compiles. Whether
  it is better is measured by the next wave: `status` shows successes per task and
  version.
- Trial workspaces link one shared Kinex Python environment,
  `<data>/self-improve/.python`, which the scheduling process prepares one trial
  at a time before any worker uses it; workers only read it.
- rosbridge does not publish a task's instruction: it is read from the run's
  folder (a `PROMPT.json`, else the simulator's line in the run log), and a
  simulator that gives none leaves the worker the task's name, which `status`
  reports. rosbridge does not report an episode's step limit either, nor take
  one: a worker is told the number only after an earlier trial of its task was
  ended at it. Its task list
  does not report splits, so `improve_tasks` selects by simulator, pattern and count.
- Trials run up to `--parallel` at a time, but their workers start `startGapS`
  apart (10 s): each loads a ROS process per device, and workers that load in the
  same moment run past the devices' ready limit.
- `config.json` can be edited while no Kinex schedules the run: `seed`, `trialTimeoutS` (3600),
  `distillTimeoutS` (7200), `startGapS` (10), `rounds`, `parallel`, `batches`, `helpers` (10,
  how many of a distiller's sub-agents run at once), `sandbox`.
  `KINEX_ROSBRIDGE` names the rosbridge command when a run is created (default
  `rosbridge` on `PATH`).
- Workers run in a bubblewrap sandbox (`"sandbox": true`); a trial refuses to start
  when bubblewrap cannot run. `KINEX_SELF_IMPROVE_SANDBOX=off` creates a run
  without it, as does `"sandbox": false` in `config.json`. See
  [isolation](../../docs/self-improve.md#isolation-and-boundaries).

## Composition

```ts
import { coreContribution, composeContributions } from "@kinex/core/integration"
import { selfImproveContribution, selfImproveToolNames } from "@kinex/self-improve"

const capabilities = composeContributions([coreContribution(runtime), selfImproveContribution(runtime)])
```

Pass `selfImproveToolNames` as reserved tool names. A host must start child
sessions the way standalone Kinex does: `src/session.ts` runs the entry point of
the current process with `run --yolo --session <file>`. It must also give the
command a `turn` in its context, which runs a prompt as a turn of the session in
front of the user, in a session of its own when the turn names a folder; without
one the command refuses to schedule.

## Jobs

`src/jobs` starts long work without blocking, queues it in lanes and collects it
with one wait. It knows no agent host and imports only Node, so any tool author
can use it.

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

From code:

```ts
import { createJobs, line } from "@kinex/self-improve/jobs/index"

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

For a model:

```ts
import { startTool, tools } from "@kinex/self-improve/jobs/tools"

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
`src/tools.ts` adopts `improve_delegate` and `improve_wait` from these as Kinex
tools.

## Development

`architecture.test.mjs` keeps `src/jobs` free of every import but Node's.
`npm run test:self-improve` runs the package tests; at the repository root
`test/self-improve.test.mjs` drives two rounds through the real CLI with a
scripted model and a stand-in rosbridge, and `test/self-improve-tui.test.mjs`
drives a run and a stop in a real terminal.

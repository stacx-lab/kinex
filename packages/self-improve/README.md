# @kinex/self-improve

Lets Kinex practise simulated robot tasks, learn from its own attempts and keep
what it learned as ordinary Kinex skills, `kinex.lib` modules and programs. Requires Node >=22.19, an
aligned `@kinex/core` version, a prepared
[rosbridge](https://github.com/stacx-lab/rosbridge), as for any simulated work,
the [pi-subagents](https://www.npmjs.com/package/pi-subagents) extension, which
standalone Kinex bundles, and to sandbox workers either
[bubblewrap](https://github.com/containers/bubblewrap) with unprivileged user
namespaces or Docker.

```text
/self-improve ten RoboCasa tasks about doors, three rounds    plan a run with the session, approve it, and it starts
/self-improve robocasa/* six rounds, batches of 10, 20, 40    the request is read by the session, whatever its form
/self-improve status [run]                                    no model: jobs, solved tasks per version
/self-improve install L2 [run]                                no model: copy L2 into this workspace
/self-improve resume [run]                                    schedule a run again from what is on disk
/self-improve stop                                            no model: end the run's jobs
```

One round is a wave of trials followed by one distillation. The command hands
the request to the session, which plans the run and has the user approve the
plan; after that code decides every step and the session only starts what it
names.

1. **Plan.** The session finds the tasks in rosbridge's catalog with
   `improve_tasks` and proposes them with `improve_plan`: tasks, rounds, trials at
   a time and batches.
2. **Approval.** `improve_plan` shows the user the plan with how a trial is
   started, ended and judged, and waits. Approving makes the run; from `ask` mode
   it also moves Kinex to `auto`, because trials and distillations go on with
   nobody to approve their steps. `yolo` does not ask. Without a user (`kinex run`)
   a session in `auto` or `yolo` goes on and one in `ask` makes no run.
3. **Run.** `improve_next` reads the run's folder and gives the call that starts
   the next background sub-agents: the wave's trials together, as many at a time
   as the plan allows, or the wave's distillation. Each is a sub-agent of
   pi-subagents, so the conversation stays the user's while they work. When they
   have ended the session is told how, with each trial's verdict and where its
   record is, and calls `improve_next` again.

| Role | Is | Package tools |
| --- | --- | --- |
| Scheduler | Code, `src/scheduler.ts`: it decides the next step from the run's folder and admits the jobs that do it | none: it is not a model |
| Session | The user's session, which plans the run and starts the sub-agents of each step | `improve_tasks` and `improve_plan` while it plans, `improve_next` while a run is scheduled |
| Worker | A headless child Kinex, one per trial, in a fresh rig workspace with one library version installed, sandboxed | none |
| Distiller | A headless child Kinex, one per distillation, in a session and a folder of its own | `improve_check` |

A wave gives every open task still unsolved one trial with the newest version;
they run as many at a time as the plan allows. With
batches, tasks open a batch a wave, in the order the last distiller asked for
(`schedule.json`). The wave is distilled before the next one opens. The run ends
when every task is solved, the rounds are done, or a round neither solved a task
nor published a version and no task is left to open. What fails is tried again
first: a trial that did not run (a setup problem, not a task failure) is started
again up to twice and its task then sits the wave out; a candidate that fails the
check gets up to two repair turns of the same distiller session; a distillation
whose session did not end normally is run again up to twice.

A **trial** is one episode of one task: `rosbridge launch` (stepped, ending where the
simulator's evaluator ends an episode, `--early-stop`), `rosbridge setup` of the same task and seed into the trial workspace
on the launched ROS domain, the library installed, one worker, then `rosbridge stop`
and `rosbridge judge`. The simulator's verdict decides; the worker's report never
counts. A **distillation** gives the distiller every finished trial's record and the
newest library, and publishes its candidate as the next version when its session
ended normally and `improve_check` finds the candidate loadable, its Python
compiling and its skills naming only what its code defines. The distiller starts
sub-agents of its own with pi-subagents' `subagent` and `bg_wait`. The distill prompts are rsi's distill-lean
prompts with the edits this design forces (one episode per trial, waves, folder
names, the check and sub-agents as tools, task skills instead of task briefs,
code as `kinex.lib` modules instead of a skill's body).

## Jobs

A trial and a distillation are each one job: a process of its own, which opens
the job's folder once the scheduler has admitted it. `improve_next` gives the
call and the session makes it:

```js
// a wave: one workflow, a trial sub-agent for each task
subagent({ workflow: "<run folder>/wave.js", args: { run: "<run>", library: "L1", tasks: ["sim/a", "sim/b"] }, globalConcurrencyLimit: 2, async: true })
// its distillation
subagent({ agent: "self-improve-distill", task: "run=<run>" })
```

pi-subagents runs each command in the background, shows it, stops it on request
and tells the session when the call's sub-agents have ended.

- The call's arguments are what the session may choose: `library` is the version
  the wave's workers are given, the newest unless the session gives another
  published one. The tasks, how often one is tried and how many run at a time are
  the scheduler's: a trial sub-agent is told `run=<run> task=<task> library=<version>`
  and asks to be admitted, so a task that is not to be tried now is refused and a
  trial beyond the plan's number waits for one to end.

- The two agents are files in Kinex's agent folder (`agents/self-improve-trial.md`,
  `agents/self-improve-distill.md`). Each names this package's command,
  `dist/main.js`, and nothing of a run: the call says the run, so Kinex processes
  that schedule different runs share the files. The files stay after a run.
- The run's `kinex.json` keeps the Kinex and the model flags of the session that
  schedules it; the command starts workers and distillers as that Kinex.
- The command ends its job an hour after the run's limit for it (`trialTimeoutS`,
  or `distillTimeoutS` and its repair turns), as it does when it is stopped.
- The command opens its job while it alone holds the run's lock and claims it
  with its process id (`claim.json`), so a task started twice is tried once.
- What it prints is what the session is told: the trial's line as `status` shows
  it and the path of its record.
- A job is a process of its own, so it goes on when the Kinex that started it
  quits. `/self-improve stop` ends the run's jobs from any Kinex.

## Files

A run keeps everything under `<Kinex data directory>/self-improve/<run>/`, outside
every workspace so that no workspace's `.kinex` leaks into a trial.

```text
config.json                 the request, tasks, rounds, parallel, batches, limits, the rosbridge command
kinex.json                  the Kinex and model flags of the session that schedules the run now
wave.js                     the pi-subagents workflow that starts a wave's trials
waves/w001.json             a wave as it was opened: its library version and tasks
libraries/L0, L1, ...       published versions; never edited, the newest is current
  manifest.json             version, parent, the distillation it came from
  payload/                  what ships: skills/  tools/  lib/  programs/  brief.md
  memory/                   the distiller's notes for later distillations; never ships
trials/t001/
  input.json                wave, task, robot, library version, limits
  claim.json                the process that does the trial
  workspace/                the rig export with the library installed
  record/                   prompt.md  session.jsonl  output.log  result.json
                            summary.md  history.md  history.json  images/   the transcript, in brief and in full
                            learned.md  learned/    what the worker kept beyond the library
distillations/d001/
  input.json                base version, trial ids, which of them are new
  workspace/                records/  reference/  library/ (the candidate)  notes/  schedule.json (the order of new tasks)
  record/                   prompt.md  session.jsonl (the distiller's own session)  output.log  result.json
                            session/<id>/  the sessions of the sub-agents it started
```

- A job is finished when its `record/result.json` exists. One without a result is
  running in the process that claimed it, or abandoned by a process that is gone. State is read by scanning these folders; no file is shared
  between running jobs.
- `payload/` uses Kinex's folder names, so installing is a copy into
  `.kinex/skills`, `.kinex/tools`, `.kinex/lib` and `.kinex/programs`; a `lib/`
  module named like a builtin `kinex.lib` module never ships. The brief goes to
  `.kinex/self-improve/brief.md`, and this package's context gives an installed
  brief to every session in that workspace as a context section, so installing
  or editing it leaves the stable prompt unchanged. A published brief has at most
  15 lines and 2,000 characters. A trial workspace
  is prepared by the same copy, so a worker sees a library exactly as a user who
  installed it. Install stops on a name that already exists.
- `session.jsonl` is a Kinex session file, a worker's or a distiller's; `kinex --export` renders it.

## Limits

- One run is scheduled in a Kinex at a time.
  `/self-improve stop` ends its jobs: workers and distillers are stopped and their
  simulators closed. Quitting Kinex does not: the jobs in flight finish and leave
  their results, and `resume` schedules the run again. A job left without a result
  is abandoned, its task is simply still unsolved, and its wave starts it again.
- The session schedules the run under its own permission mode, `auto` or `yolo`
  once the plan is approved. It is told of every job that ends, which takes a
  short turn of the conversation.
- Headless, `kinex run --auto "/self-improve ..."` returns when the run has ended;
  it waits half an hour for a job by default (pi-subagents' `timeoutMs`), so a
  long run is better scheduled from the terminal. Interrupted, it waits for its
  jobs; `/self-improve stop` from another Kinex ends them.
- Workers keep network access. The numbers show whether a library helps; they
  are not benchmark results.
- The check guarantees that a library loads and that its code compiles. Whether
  it is better is measured by the next wave: `status` shows successes per task and
  version.
- Trial workspaces link one shared Kinex Python environment,
  `<data>/self-improve/.python`, which trials prepare one at a time before any
  worker uses it; workers only read it.
- rosbridge does not publish a task's instruction: it is read from the run's
  folder (a `PROMPT.json`, else the simulator's line in the run log), and a
  simulator that gives none leaves the worker the task's name, which `status`
  reports. rosbridge does not report an episode's step limit either, nor take
  one: a worker is told the number only after an earlier trial of its task was
  ended at it. Its task list
  does not report splits, so `improve_tasks` selects by simulator, pattern and count.
- Trials run as many at a time as the plan says, but their workers start `startGapS`
  apart (10 s): each loads a ROS process per device, and workers that load in the
  same moment run past the devices' ready limit.
- `config.json` can be edited while no job of the run is running: `seed`, `trialTimeoutS` (3600),
  `distillTimeoutS` (7200), `startGapS` (10), `rounds`, `parallel`, `batches`, `helpers` (10,
  how many of a distiller's sub-agents run at once), `sandbox`, `image`.
  `KINEX_ROSBRIDGE` names the rosbridge command when a run is created (default
  `rosbridge` on `PATH`).
- Workers run in a sandbox (`"sandbox": true`): bubblewrap where it can run, else
  a Docker container (`"image"`, default `ubuntu:24.04`, with the host's system
  folders bound over it). `"sandbox": "bwrap"` or `"docker"` names one. A plan is
  refused when the sandbox it would use cannot start a worker here: Docker cannot
  where it may not read Node's, Kinex's or the configuration's folder, as on a
  home folder its daemon has no access to. `KINEX_SELF_IMPROVE_SANDBOX=off` plans
  a run without a sandbox, and `=bwrap` or `=docker` names one. See
  [isolation](../../docs/self-improve.md#isolation-and-boundaries).

## Composition

```ts
import { coreContribution, composeContributions } from "@kinex/core/integration"
import { selfImproveContribution, selfImproveToolNames } from "@kinex/self-improve"

const capabilities = composeContributions([coreContribution(runtime), selfImproveContribution(runtime)])
```

Pass `selfImproveToolNames` as reserved tool names. The package asks three
things of its host, and standalone Kinex gives them:

- The pi-subagents extension, whose `subagent` tool starts a job in the
  background and whose notice tells the session when it has ended. Standalone
  keeps it closed until `unattended` is granted, and open from the start in a
  process started with `KINEX_SUBAGENTS=on`, as a distiller's is.
- The permission `unattended`, which `improve_plan` asks for: the host shows the
  user the description and lets the session work without approvals once they
  agree.
- An entry point that runs a headless child the way standalone does:
  `src/session.ts` starts it with `run --yolo --session <file>`.

## Development

`npm run test:self-improve` runs the package tests; at the repository root
`test/self-improve.test.mjs` drives runs through the real CLI with a
scripted model and a stand-in rosbridge, and `test/self-improve-tui.test.mjs`
drives the approval, a run and a stop in a real terminal.

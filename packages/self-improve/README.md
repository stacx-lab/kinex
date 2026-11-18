# @kinex/self-improve

Lets Kinex practise simulated robot tasks, learn from its own attempts and keep
what it learned as ordinary Kinex skills, `kinex.lib` modules and programs. Requires Node >=22.19, an
aligned `@kinex/core` version and a prepared
[rosbridge](https://github.com/stacx-lab/rosbridge), as for any simulated work.

```text
/self-improve robocasa/add-ice-cubes robocasa/adjust-heat     named tasks
/self-improve libero/libero-spatial-* --rounds 3              a group, three rounds
/self-improve ten RoboCasa tasks about doors --parallel 2     free text, two trials at a time
/self-improve status [run]                                    no model: jobs, solved tasks per version
/self-improve install L2 [run]                                no model: copy L2 into this workspace
/self-improve resume [run]                                    continue a run from what is on disk
/self-improve stop                                            no model: stop scheduling in this session
```

One round is a wave of trials followed by one distillation. The session that
runs the command only schedules; the work happens in headless child Kinex
sessions that use its model and login.

| Role | Is | Package tools |
| --- | --- | --- |
| Scheduler | The session where `/self-improve` ran, following `src/scheduler.txt` | `improve_tasks`, `improve_run_trial`, `improve_distill`, `improve_wait`, `improve_status` |
| Worker | One per trial, in a fresh rig workspace with one library version installed | none |
| Distiller | One per distillation, in a folder of copied trial records | `improve_delegate`, `improve_wait`, `improve_check` |
| Helper | A sub-agent a distiller starts with a prompt it writes | none |

A **trial** is one episode of one task: `rosbridge launch` (stepped, ending at the
first success), `rosbridge setup` of the task's robot into the trial workspace on
the launched ROS domain, the library installed, one worker, then `rosbridge stop`
and `rosbridge judge`. The simulator's verdict decides; the worker's report never
counts. A **distillation** gives a distiller every finished trial's record and the
newest library, and publishes its candidate as the next version when
`improve_check` finds it loadable. The distill prompts are rsi's distill-lean
prompts with the edits this design forces (one episode per trial, waves, folder
names, the check and sub-agents as tools, task skills instead of task briefs,
code as `kinex.lib` modules instead of a skill's body).

## Files

A run keeps everything under `<Kinex data directory>/self-improve/<run>/`, outside
every workspace so that no workspace's `.kinex` leaks into a trial.

```text
config.json                 the request, rounds, parallel, limits, the rosbridge command
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
  workspace/                records/  reference/  library/ (the candidate)  notes/
  record/                   as for a trial, plus helpers/<name>/
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
- `session.jsonl` is the child's own Kinex session file; `kinex --export` renders it.

## Limits

- The scheduler's role belongs to the session where `/self-improve` ran. `/new`,
  a resumed session or another workspace is an ordinary session, and so is the
  scheduling session after `/self-improve stop`. Neither ends a job: `status`
  shows what is running and `resume` makes a session the scheduler again.
- Jobs belong to the Kinex runtime that started them: one workspace of one
  process. Quitting, or opening another workspace, ends its workers and stops
  their simulators; a job left without a result is abandoned and its task is
  simply still unsolved. `resume` continues from finished jobs.
- Workers are kept to their workspace by a clean workspace, a trimmed environment
  and an instruction, not by a sandbox, and they keep network access. The numbers
  show whether a library helps; they are not benchmark results.
- The check guarantees that a library loads. Whether it is better is measured by
  the next wave: `status` shows successes per task and version.
- Trial workspaces link one shared Kinex Python environment,
  `<data>/self-improve/.python`, built by the first worker that needs it.
- rosbridge prints a task's instruction to its run log only for simulators that
  have one (RoboCasa); otherwise the worker is given the task's name. Its task list
  does not report splits, so `improve_tasks` selects by simulator, pattern and count.
- Trials run up to `--parallel` at a time, but their workers start `startGapS`
  apart (10 s): each loads a ROS process per device, and workers that load in the
  same moment run past the devices' ready limit.
- `config.json` can be edited between sessions: `seed`, `trialTimeoutS` (3600),
  `distillTimeoutS` (7200), `startGapS` (10), `rounds`, `parallel`. `KINEX_ROSBRIDGE`
  names the rosbridge command when a run is created (default `rosbridge` on `PATH`).

## Composition

```ts
import { coreContribution, composeContributions } from "@kinex/core/integration"
import { selfImproveContribution, selfImproveToolNames } from "@kinex/self-improve"

const capabilities = composeContributions([coreContribution(runtime), selfImproveContribution(runtime)])
```

Pass `selfImproveToolNames` as reserved tool names. A host must start child
sessions the way standalone Kinex does: `src/session.ts` runs the entry point of
the current process with `run --yolo --session <file>`.

## Development

`npm run test:self-improve` runs the package tests; `test/self-improve.test.mjs`
at the repository root drives two rounds through the real CLI with a scripted
model and a stand-in rosbridge.

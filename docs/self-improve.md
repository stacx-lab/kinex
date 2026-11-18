# Self-improvement

`/self-improve` lets Kinex practise simulated tasks, distill its attempts into a
library and install that library as ordinary Kinex content: skills, `kinex.lib`
modules, programs and a short brief. A library adds nothing Kinex cannot already discover. Success counts
show whether a library helps; they are not benchmark results.

## Roles

The session that runs `/self-improve` only schedules; headless child sessions do
the work. Children run the current process's entry point with
`run --yolo --session <file>`, inherit its `--model`, `--provider` and `--thinking`,
and learn their role from `KINEX_SELF_IMPROVE_ROLE`.

| Role | Runs in | Package tools |
| --- | --- | --- |
| Scheduler | The user's session after start or `resume` | `improve_tasks`, `improve_run_trial`, `improve_distill`, `improve_wait`, `improve_status` |
| Worker | A trial workspace with one library version installed; starts with `/load all` | none |
| Distiller | A folder of copied trial records and the candidate library | `improve_delegate`, `improve_wait`, `improve_check` |
| Helper | The distiller's folder, in its process group | none |

The scheduler role belongs to one host session: its rules travel as a context
section and survive compaction. `/new`, a resumed session, another workspace or
`/self-improve stop` make it an ordinary session; `resume` takes the role back.
The run reaches tools with each call, so no other session becomes a scheduler.
`/self-improve` is refused inside a child.

## Trials and verdicts

A trial is one stepped episode of one task: `rosbridge launch` on a ROS domain of
its own, `rosbridge setup` of the task's robot into the trial workspace, the
library installed, one worker, then `rosbridge stop` and `rosbridge judge`. The
simulator's verdict decides; the worker's report never counts. A worker that
exits non-zero after the simulation advanced is still judged; one that fails
before it advanced leaves a trial that did not run. Worker starts are spaced
`startGapS` apart so device loads do not time each other out.

Distillation waits for every running job to end and needs at least one finished
trial not yet distilled; no trial starts while it runs. The distiller gets every
finished trial's record, Kinex's reference (the core README, the `kinex` Python
package with its builtin `kinex.lib` modules and the trial robot's profiles) and a copy of the newest
version as its candidate.

## Libraries

Versions `L0`, `L1`, … are published by renaming a complete staging folder and
are never edited; the newest is current. `payload/` ships and uses Kinex's folder
names (`skills/`, `tools/`, `lib/`, `programs/`, `brief.md`); `memory/` is the
distiller's and never ships. Code ships as `kinex.lib` modules in `lib/`, and
whole-task programs in `programs/`. A candidate publishes only when its session
ended normally and the check passes. The check guarantees that the library loads
and leaves Kinex's own intact: skill frontmatter and unique names, only `.ts` and
`.js` files in `tools/`, no `lib/` module named like a builtin `kinex.lib` module
(it would replace that module for every worker), and a brief of at most 15 lines
and 2,000 characters. It runs nothing. Whether a library is better is measured by
the next wave.

Installing copies each payload folder into the workspace's folder of the same
name under `.kinex` and the brief to `.kinex/self-improve/brief.md`, replacing
an installed brief. It stops before copying when a name already exists. Trial workspaces are prepared by the same copy, so a worker sees a
library exactly as a user who installed it. An installed brief is a context
section of every session in that workspace; installing or editing it never
changes the stable prompt.

## Run state and lifecycle

A run lives under `<Kinex data directory>/self-improve/<run>/`, outside every
workspace, because discovery merges each ancestor's `.kinex`. Job folders are
reserved by creating them; a job is finished when its atomically written
`record/result.json` exists, and status is read by scanning folders. Running jobs
share no file.

Jobs belong to the runtime that started them. Its in-memory table is the only
record of what is running, so a runtime never sees another's jobs. Disposal ends
workers, and simulators the process launched are stopped when it exits. A job
left without a result is abandoned, not failed; `resume` continues from finished
jobs. Cancelling a wait never cancels the work.

## Isolation and boundaries

Children run without permission prompts. They are kept to their folder by a clean
workspace, an environment without rosbridge's activation and an instruction, not
by a sandbox, and they keep network access. Trial workspaces link one shared
Kinex Python environment, which the scheduling process prepares one trial at a
time before any worker uses it.

The package reaches simulators only through the rosbridge command and core only
through package exports. Standalone composes it by default and ships it inside
its archive, so its dependencies are peers; see
[installation and releases](distribution.md#releases-and-validation).

See the [self-improve README](../packages/self-improve/README.md) for commands,
run files and settings.

[Design index](README.md)

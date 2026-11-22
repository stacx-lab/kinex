# Self-improvement

`/self-improve` lets Kinex practise simulated tasks, distill its attempts into a
library and install that library as ordinary Kinex content: skills, `kinex.lib`
modules, programs and a short brief. A library adds nothing Kinex cannot already discover. Success counts
show whether a library helps; they are not benchmark results.

## Roles

Code schedules a run and the main session distills it; headless child sessions
do the rest. Children run the current process's entry point with
`run --yolo --session <file>`, inherit its `--model`, `--provider` and `--thinking`,
and learn their role from `KINEX_SELF_IMPROVE_ROLE`.

| Role | Runs in | Package tools |
| --- | --- | --- |
| Scheduler | A loop in code in the Kinex process | none |
| Distiller | The main session, for one turn, in a session of its own rooted in the distillation's folder | `improve_delegate`, `improve_wait`, `improve_check` |
| Worker | A child in a trial workspace with one library version installed; starts with `/load all` | none |
| Helper | A child in the distiller's folder, in the process group of the Kinex that distills | none |

The scheduler asks the host for one thing: a turn of the session in front of the
user. For a distillation the turn names a folder and a session file, so the host
opens an empty session there, as it would a session of another workspace: the
workspace runtime, the context and the transcript are the distillation's, and
the user's own session returns when the turn has ended. This is rsi's
arrangement, a scheduler in code and a fresh principal session per distillation
whose memory travels in the library, with the main session as that principal.

The main session has the package's tools only during a turn the scheduler gave
it: the three above in a distillation's folder, and `improve_tasks` and
`improve_select` in the one short turn that converts a free-text request into
task ids. A request made of ids or patterns needs no model. `/self-improve` is
refused inside a child, and needs a session that works without approvals: in
`ask` mode it offers to switch to `auto` and otherwise does not start.

## Trials and verdicts

A trial is one stepped episode of one task: `rosbridge launch` on a ROS domain of
its own, `rosbridge setup` of the same task and seed into the trial workspace, the
library installed, one worker, then `rosbridge stop` and `rosbridge judge`. The
simulator's verdict decides; the worker's report never counts. A worker that
exits non-zero after the simulation advanced is still judged; one that fails
before it advanced leaves a trial that did not run. Worker starts are spaced
`startGapS` apart so device loads do not time each other out.

A wave gives every open task still unsolved one trial with the newest version.
Without `--batches` every task is open from the first wave. With
`--batches 10,20,40` the first wave opens ten tasks, the next twenty more, then
forty, then the rest: a later wave retries the open tasks still unsolved and opens
the next batch, so most tasks meet a library on their first trial. Tasks open in
a fixed order (a hash of their ids), or in the order the last distiller left in
`schedule.json` at its folder's root, as `{"next": [task ids]}`; it is asked for
one only while tasks are unopened.

A wave not yet given to a distillation is distilled before the next one starts,
and no trial runs meanwhile. The distiller gets every finished trial's record,
Kinex's reference (the core README, the `kinex` Python package with its builtin
`kinex.lib` modules and the trial robot's profiles) and a copy of the newest
version as its candidate. Its turn ends at the distillation's deadline at the
latest, and only a turn that ended normally can publish.

What fails is tried again before the run goes on without it, with rsi's counts:

- A trial that did not run is started again, up to twice a wave; a task whose
  trial still has not run sits that wave out. A wave none of whose trials ran
  ends the run: that is the setup's failure.
- A candidate that fails the check is not dropped for the version before: the
  distiller's session gets up to two repair turns of half an hour, each shown what
  the check found.
- A distillation whose turn did not end normally (its deadline, an error) publishes
  nothing; its trials are distilled again from the published version, up to twice.

After that the run goes on with the version it has.

A worker is given its task's goal in the simulator's own words, read from the
run's folder: a `PROMPT.json` there, else the line the simulator prints to the
run log when the episode starts. A simulator that gives none leaves the task's
name, and `status`, `result.json` and the distiller's `TASKS.md` say so. The
worker is told that the simulation is stepped, that the simulator ends the
episode as soon as its check passes (Kinex launches it with `--early-stop`), so an
episode still running is not yet done, and that it may also end the episode at a
step limit of its own. rosbridge does not report that limit, so the
number is given only once an earlier trial of the task was ended at it.

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
and 2,000 characters. As rsi's gate does, it also reads the code without running
it: every Python file in `lib/` and `programs/` compiles, a skill or the brief
names nothing in a `lib/` module that the module does not define, and every line
of `memory/rows/*.jsonl` is a JSON object. Whether a library is better is measured
by the next wave.

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

A run belongs to the Kinex process that schedules it, because the main session
leaves its workspace for every distillation; one run is scheduled at a time. Each
pass of the scheduler decides its next step from the run's folder alone. Trials
and helpers are [jobs](../packages/self-improve/README.md#jobs): starting returns at once, a
lane runs up to its limit, and one wait collects them; cancelling a wait never
cancels the work. `/self-improve stop` and quitting end a run's work: workers and
helpers are stopped, and simulators the process launched are closed. A job left
without a result is abandoned, not failed; `resume` continues from finished jobs.

## Isolation and boundaries

Children run without permission prompts. A worker runs in a bubblewrap sandbox
that the scheduling process builds from an empty root, with its own process, IPC
and mount namespaces and no capabilities. It can write only its workspace, its
transcript and Kinex's agent folder (credentials refresh there; settings stay
read-only), and read only the system, Node, Kinex, the shared Python environment
and Kinex's configuration. rosbridge's command, files and processes, other jobs,
the run's libraries and every verdict have no name inside, so a worker can neither
stop its simulator nor change its outcome: `rosbridge launch`, `setup`, `stop`
and `judge` all run outside. It shares the host's network, which DDS to its
simulator and the model's API need, so other ROS domains and the internet stay
reachable. Its `/dev/shm` is its own, so DDS reaches the simulator over UDP. A run
made before the sandbox, or with `"sandbox": false`, runs workers unsandboxed;
helpers always do, kept to their folder by a clean workspace, an environment
without rosbridge's activation and an instruction. A distiller is the main
session under its own permission mode, rooted in the distillation's folder, whose
context holds nothing of the workspace the run was started in.

Trial workspaces link one shared Kinex Python environment, which the scheduling
process prepares one trial at a time before any worker uses it; workers read it
only.

The package reaches simulators only through the rosbridge command and core only
through package exports. Standalone composes it by default and ships it inside
its archive, so its dependencies are peers; see
[installation and releases](distribution.md#releases-and-validation).

See the [self-improve README](../packages/self-improve/README.md) for commands,
run files and settings.

[Design index](README.md)

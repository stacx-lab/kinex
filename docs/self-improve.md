# Self-improvement

`/self-improve` lets Kinex practise simulated tasks, distill its attempts into a
library and install that library as ordinary Kinex content: skills, `kinex.lib`
modules, programs and a short brief. A library adds nothing Kinex cannot already discover. Success counts
show whether a library helps; they are not benchmark results. The
[self-improve README](../packages/self-improve/README.md) has the commands, a
run's files and its settings; this page keeps the contracts.

## Roles

| Role | Runs in | Package tools |
| --- | --- | --- |
| Scheduler | Code that decides the next step from the run's folder and admits the jobs that do it | none |
| Session | The user's session: it plans the run and starts the sub-agents of each step | `improve_tasks`, `improve_plan`; then `improve_next` |
| Worker | A headless child Kinex in a trial workspace with one library version installed; starts with `/load all`; sandboxed | none |
| Distiller | A headless child Kinex in the distillation's folder, in a session of its own | `improve_check` |

- `/self-improve <request>` is a workflow: the session reads the request, settles
  how kinex-sim is run for it (its command and environment, more options for
  `launch`, a seed), finds the tasks and proposes a plan. Nothing exists until the
  user approves it, with the lines a trial is started, ended and judged with.
  `improve_plan` asks for the permission `unattended` with the plan as its
  description; the host shows it, and from `ask` mode the approval moves the
  session to `auto`. `yolo` does not ask, and without a user only a session that
  already works without approvals goes on.
- The scheduler is code and starts nothing. `improve_next` returns its decision
  and opens no job: the wave's tasks to try or the distillation, as a call of
  [pi-subagents](https://www.npmjs.com/package/pi-subagents)' `subagent` tool.
  A wave's trials start together as one workflow, as many at a time as the plan
  allows; the session is told once, when all have ended, with each trial's
  verdict and the path of its record, and asks again.
- The session starts the sub-agents, and what it may choose is in the call's
  arguments: today the library version a wave's workers are given, the newest
  unless it gives another published one. Every sub-agent asks the scheduler to
  be admitted before it does anything, so which tasks are tried, how often and
  how many at a time holds whatever the session started: a task that is not to
  be tried now is refused, and a trial beyond the plan's number waits.
  Standalone keeps pi-subagents [closed](agent-integration.md) until the plan is
  approved, so a session has its tools from then on and no other session has
  them. A distiller's Kinex is started with it open.
- The session has the package's tools only while it plans or schedules a run. A
  worker has none and starts no sub-agents. A distiller has the gate and starts
  sub-agents of its own with pi-subagents. `/self-improve` is refused inside a child.
- Children run the entry point of the Kinex that scheduled the run with
  `run --yolo --session <file>`, take its `--model`, `--provider` and `--thinking`,
  and learn their role from `KINEX_SELF_IMPROVE_ROLE`.

## Trials and verdicts

A trial is one stepped episode of one task: `kinex-sim launch` with the plan's
options, stepped, ending where the simulator's check does and on a ROS domain of
its own, which no plan can change, `kinex-sim setup` of the same task and seed into the trial workspace, the
library installed, one worker, then `kinex-sim stop` and `kinex-sim judge`. The
simulator's verdict decides; the worker's report never counts. A worker that
exits non-zero after the simulation advanced is still judged; one that fails
before it advanced leaves a trial that did not run. Worker starts are spaced
`startGapS` apart so device loads do not time each other out.

A wave gives every open task still unsolved one trial with the newest version,
as many at a time as the plan allows. A wave is written down when it opens, so
its tasks and library stay what they were. With batches of 10, 20 and 40 the
first wave opens ten tasks, the next twenty more, then forty, then the rest: a
later wave retries the open tasks still unsolved and opens the next batch, so
most tasks meet a library on their first trial. Tasks open in a fixed order (a
hash of their ids), or in the order the last distiller left in `schedule.json`
at its folder's root, as `{"next": [task ids]}`; it is asked for one only while
tasks are unopened.

A wave is distilled before the next one opens, and no trial runs meanwhile. The
distiller gets every finished trial's record, Kinex's reference (the core README,
the `kinex` Python package with its builtin `kinex.lib` modules and the trial
robot's profiles) and a copy of the newest version as its candidate. Its session
ends at the distillation's deadline at the latest, and only a session that ended
normally can publish.

What fails is tried again before the run goes on without it, with rsi's counts:

- A trial that did not run, or whose process ended without a result, is started
  again, up to twice a wave; a task whose trial still has not run sits that wave
  out. A wave none of whose trials ran ends the run: that is the setup's failure.
- A candidate that fails the check is not dropped for the version before: the
  distiller's session gets up to two repair turns of half an hour, each shown what
  the check found.
- A distillation whose session did not end normally (its deadline, an error)
  publishes nothing; its trials are distilled again from the published version,
  up to twice.

After that the run goes on with the version it has.

A worker is given its task's goal in the simulator's own words: the launched
episode's task description, which `kinex-sim describe` reads from the run's log,
its instruction first and then any further text the simulator states. A
simulator that gives none leaves the task's
name, and `status`, `result.json` and the distiller's `TASKS.md` say so. The
worker is told that the simulation is stepped, that the simulator ends the
episode as soon as its check passes (Kinex launches it with `--early-stop`), so an
episode still running is not yet done, and that it may also end the episode at a
step limit of its own. kinex-sim's commands do not report that limit, so the
number is given only once an earlier trial of the task was ended at it.

## Libraries

Versions `L0`, `L1`, … are published by renaming a complete staging folder and
are never edited; the newest is current. `payload/` ships and uses Kinex's folder
names (`skills/`, `tools/`, `lib/`, `programs/`, `brief.md`); `memory/` is the
distiller's and never ships. Code ships as `kinex.lib` modules in `lib/`, and
whole-task programs in `programs/`. A candidate publishes only when its session
ended normally and the check passes. The check guarantees that the library loads
and leaves Kinex's own intact: skill frontmatter and unique names, only `.ts` and
`.js` files in `tools/`, no `lib/` module named like a builtin `kinex.lib` module,
core's or one a composed package adds (it would replace that module for every
worker), and a brief of at most 15 lines and 2,000 characters. As rsi's gate
does, it also reads the code without running it: every Python file in `lib/` and
`programs/` compiles, a skill or the brief names nothing in a `lib/` module that
the module does not define, and every line of `memory/rows/*.jsonl` is a JSON
object. Whether a library is better is measured by the next wave.

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

A job is done by a process of its own, which a background sub-agent runs. The
call says the run, and for a trial the task and the library version
(`run=<run> task=<task> library=L1`), so the two agent files that name the
command are the same for every run, and Kinex processes that schedule different
runs share them. The process asks the scheduler for its job while it alone holds
the run's lock, and opens the job's folder itself, claimed with its process id:
a job is never opened twice, and one whose process is gone without a result is
abandoned. What passes between a job and everything else is files in the run's
folder; a sub-agent's own words are one line and the path of its record. The run's
`kinex.json` keeps which Kinex schedules it now: its children are that Kinex on
that model. A job ends itself an hour after its run's limit for it. Jobs take turns, through a lock in the runs'
folder, at what must not happen twice at once: building the shared Python
environment and starting a worker. Because a job is its own process it outlives
the Kinex that started it; `/self-improve stop` ends a run's jobs, their workers
and their simulators from any Kinex. A job whose process is gone without a
result is abandoned, not failed; `resume` schedules the run again, and the
scheduler continues from what the folders hold.

## Isolation and boundaries

Children run without permission prompts. A worker runs in a sandbox built from
an empty root, bubblewrap's or where that cannot run a Docker container's, with
its own process, IPC and mount namespaces and no capabilities. It can write only
its workspace, its transcript and Kinex's agent folder (credentials refresh
there; settings and the commands a run's jobs are started with stay read-only),
and read only the system, Node, Kinex, the shared Python environment and Kinex's
configuration. kinex-sim's command, files and processes, other jobs, the run's
libraries and every verdict have no name inside, so a worker can neither stop
its simulator nor change its outcome: `kinex-sim launch`, `setup`, `stop` and
`judge` all run outside, in the trial's own process. It shares the host's
network, which DDS to its simulator and the model's API need, so other ROS
domains and the internet stay reachable. Its `/dev/shm` is its own, so DDS
reaches the simulator over UDP. A run planned with the sandbox off runs workers
unsandboxed. A distiller is never sandboxed: it is kept to its folder by a clean
workspace, an environment without kinex-sim's activation and an instruction, and
its context holds nothing of the workspace the run was planned in.

The package reaches simulators only through the kinex-sim command, core only
through package exports, and background work only through pi-subagents, which
standalone bundles. Standalone composes the package by default and ships it
inside its archive, so its dependencies are peers; see
[installation and releases](distribution.md#releases-and-validation).

[Design index](README.md)

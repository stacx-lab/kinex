# Self-improvement

Kinex practises simulated tasks with a self-improvement strategy, each a command
of its own:

- `/code-as-skill` practises tasks in rounds and distills its attempts into a
  library that installs as ordinary Kinex content: skills, `kinex.lib` modules,
  programs and a short brief, so that later workers, and tasks never practised,
  start from what earlier ones learned. A library adds nothing Kinex cannot
  already discover.
- `/code-as-policy` is a skeleton so far: it will practise one task over seeds and
  layouts until a program does it, and return that program.

Success counts show whether what a run made helps; they are not benchmark
results. The [self-improve README](../packages/self-improve/README.md) has the
commands, a run's files and its settings; this page keeps the contracts.

## What every strategy shares

The package's `src/common/` holds what every strategy is built on, and each
strategy's own parts are in `src/strategies/<strategy>/`. A strategy is a
`Strategy` (`src/common/strategy.ts`): its command and usage, its tools, the
prompt a run is planned with, `status` and `resume` of a run, the folders its jobs
are kept in, and its jobs by kind. What follows holds for every strategy.

- A run is planned with the user. `/<strategy> <request>` is a workflow: the
  session reads the request, settles how kinex-sim is run for it (its command
  and environment, more options for `launch`, a seed), finds the tasks with
  kinex-sim's own `tasks list` and proposes a plan with the strategy's plan tool.
  Nothing exists until the user approves it: the tool asks for the permission
  `unattended` with the plan as its description; the host shows it, and from
  `ask` mode the approval moves the session to `auto`. `yolo` does not ask, and
  without a user only a session that already works without approvals goes on.
- A strategy's scheduler is code and starts nothing. The strategy's next tool
  returns its decision as calls of
  [pi-subagents](https://www.npmjs.com/package/pi-subagents)' `subagent` tool,
  and opens no job; the session starts the sub-agents, and is told when they have
  ended. Every sub-agent asks the scheduler to be admitted before it does anything,
  so what the run does holds whatever the session started. Standalone keeps
  pi-subagents [closed](agent-integration.md) until a plan is approved, so a session
  has its tools from then on and no other session has them.
- A session has a strategy's tools only while it plans or schedules a run of it,
  and one run is scheduled in a Kinex process at a time, whichever strategy made
  it. A strategy's command is refused inside a child.
- A child is a headless Kinex: the entry point of the Kinex that scheduled the
  run, with `run --yolo --session <file>`, its `--model`, `--provider` and
  `--thinking`, and `KINEX_SELF_IMPROVE_ROLE=<strategy>/<role>`. A role says
  what the child is sent first and whether it starts sub-agents of its own, which
  pi-subagents then keeps beside its session file; a child that starts none
  cannot.
- An episode is `kinex-sim launch` with the plan's options, stepped, ending where
  the simulator's check does and on a ROS domain of its own, which no plan can
  change, and `kinex-sim setup` of the same task and seed into a fresh workspace;
  it ends with `kinex-sim stop`, and `kinex-sim judge` decides. The simulator's
  verdict counts, never a worker's report. A worker that exits non-zero after the
  simulation advanced is still judged; one that fails before it advanced leaves
  an episode that did not run. Worker starts are spaced `startGapS` apart,
  whichever run and strategy they belong to, so device loads do not time each
  other out.

### Run state and lifecycle

A run belongs to the workspace it was planned in and lives under
`.kinex/self-improve/<strategy>/runs/<run>/` there, beside
`.kinex/self-improve/python/`, the Kinex Python that the workspace's children
share; `status`, `resume` and `stop` see that workspace's runs, and another
workspace's run is named by its folder. Discovery merges each ancestor's `.kinex`,
but children run only in a sandbox, where nothing of the workspace above their own
folder has a name, and the shared Python is prepared from the settings a worker
reads there: the global configuration's and its own workspace's. Job folders are
reserved by creating them; a job is finished when its atomically written
`record/result.json` exists, and status is read by scanning folders. Running jobs
share no file.

A job is done by a process of its own, which a background sub-agent runs: the
agent `<strategy>-<kind>` in Kinex's agent folder names this package's
`main.js <strategy> <kind>`. The call says the run, `run=<run folder>`, and the
words the kind names, so the agent files are the same for every run, and Kinex
processes that schedule different runs share them. The process asks the scheduler
for its job while it alone holds the run's lock, and opens the job's folder
itself, claimed with its process id: a job is never opened twice, and one whose
process is gone without a result is abandoned. What passes between a job and
everything else is files in the run's folder; a sub-agent's own words are one
line and the path of its record. While it works, a job writes a newline to
standard error every 30 s: pi-subagents sees of an external command only its
output, and takes one silent for a minute for a sub-agent that needs attention.
The run's `scheduler.json` keeps which Kinex schedules it now: its children are
that Kinex on that model. A job ends itself an hour after its run's limit for it.
Jobs take turns at what must not happen twice at once: building the workspace's
shared Python environment, through a lock beside it, and starting a worker,
through a lock in Kinex's data folder, since every worker of the machine loads
devices. Because a job is its own process it outlives the Kinex that started it;
`/<strategy> stop` ends a run's jobs, their workers and their simulators from any
Kinex. `resume` schedules the run again, and the scheduler continues from what
the folders hold.

## code-as-skill

| Role | Runs in | Package tools |
| --- | --- | --- |
| Scheduler | Code that decides the next step from the run's folder and admits the jobs that do it | none |
| Session | The user's session: it plans the run and starts the sub-agents of each step | `skill_plan`; then `skill_next` |
| Worker | A headless child Kinex in a trial workspace with one library version installed; starts with `/load all`; sandboxed | none |
| Distiller | A headless child Kinex in the distillation's folder, in a session of its own; sandboxed | `skill_check` |

- The plan names the tasks, all on one robot, the rounds, the trials at a time and
  any batches; the user is shown them in sections, with the command that runs
  kinex-sim once and the lines a trial is started, ended and judged with.
- `skill_next` gives the wave's tasks to try or the distillation. A wave's trials
  start together as one workflow, as many at a time as the plan allows; the
  session is told once, when all have ended, with each trial's verdict and the
  path of its record, and asks again.
- What the session may choose is in the call's arguments: today the library
  version a wave's workers are given, the newest unless it gives another
  published one. A task that is not to be tried now is refused, and a trial beyond
  the plan's number waits.
- A worker has no tools of the package and starts no sub-agents. A distiller has
  the gate and starts sub-agents of its own with pi-subagents; its Kinex is
  started with pi-subagents open.

### Trials and verdicts

A trial is one episode of one task with the library installed in its workspace
and one worker.

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

### Libraries

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

`/code-as-skill install <version>` copies each payload folder into the
workspace's folder of the same name under `.kinex` and the brief to
`.kinex/self-improve/code-as-skill/brief.md`, replacing an installed brief. It
stops before copying when a name already exists. Trial workspaces are prepared
by the same copy, so a worker sees a library exactly as a user who installed it.
An installed brief is a context section of every session in that workspace;
installing or editing it never changes the stable prompt.

## Isolation and boundaries

Children run without permission prompts, and only in a sandbox built from an
empty root, bubblewrap's or where that cannot run a Docker container's, with its
own process, IPC and mount namespaces and no capabilities. A host where neither
can start one has its plans refused; there is no way to run a child without one.
A child can write only its workspace, its transcript and Kinex's agent folder
(credentials refresh there; settings and the commands a run's jobs are started
with stay read-only); one that starts sub-agents, a distiller, writes its record
instead of its transcript, because pi-subagents keeps what its sub-agents leave
beside its session file, and its sub-agents run in its sandbox. A child reads only
the system, Node, Kinex, the shared Python environment and Kinex's configuration.
The workspace the run belongs to, kinex-sim's command, files and processes, other
jobs, what the run has made and every verdict have no name inside, so a worker
can neither stop its simulator nor change its outcome: `kinex-sim launch`,
`setup`, `stop` and `judge` all run outside, in the job's own process. A
distiller's workspace has a Kinex folder of its own, so Kinex never takes the one
above it. A child shares the host's network, which DDS to a worker's simulator
and the model's API need, so other ROS domains and the internet stay reachable.
Its `/dev/shm` is its own, so DDS reaches the simulator over UDP. A child does not
take this process's `ROS_HOME` or `ROS_LOG_DIR`, which name host folders it does
not have: ROS keeps its logs in `~/.ros`, in the sandbox's own home.

The package reaches simulators only through the kinex-sim command, core only
through package exports, and background work only through pi-subagents, which
standalone bundles. Standalone composes the package by default and ships it
inside its archive, so its dependencies are peers; see
[installation and releases](distribution.md#releases-and-validation).

[Design index](README.md)

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/kinex-logo-text-night.svg">
    <img src="assets/kinex-logo-text-day.svg" alt="Kinex" height="160">
  </picture>
</p>

<p align="center">
  A coding-agent harness for robots. Real hardware and simulators, from one terminal.
</p>

<p align="center">
  <a href="https://github.com/stacx-lab/kinex/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/stacx-lab/kinex/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/stacx-lab/kinex/releases"><img alt="Release" src="https://img.shields.io/github/v/release/stacx-lab/kinex?display_name=tag"></a>
  <img alt="Runtime: Node.js" src="https://img.shields.io/badge/runtime-Node.js-339933?logo=node.js&logoColor=white">
  <img alt="Platforms" src="https://img.shields.io/badge/platforms-linux%20%7C%20macOS-blue">
</p>

<p align="center">
  <a href="#run-this-checkout">Run locally</a> ·
  <a href="#commands">Commands</a> ·
  <a href="#headless">Headless</a> ·
  <a href="#configuration-and-permissions">Configuration</a> ·
  <a href="#checks-and-packaging">Development</a>
</p>

A standalone robotics coding agent, powered by the published Pi SDK. Run `kinex`
for an interactive terminal or `kinex run` for a single task. No separate Pi
installation is required.

## Run this checkout

```sh
nvm use                         # Node 22.19 or newer
npm ci
npm run build
npm run dev
```

From a robot workspace:

```sh
cd /path/to/robot-workspace
/path/to/kinex/bin/kinex.mjs
```

Use `/login` to authenticate and `/model` to select a model. The provider catalog,
OAuth flows, streaming, retries, compaction and session history come from Pi
0.87.1. Existing provider API-key environment variables are supported by Pi.
Robot device commands work without model credentials.

Device, recording, stop and key controller tool headers show their action/target.
Expand a tool with Pi's tool-expansion control (Ctrl+O by default) to inspect its
arguments and complete returned result. Active recording displays a red
`rec: <recording name>` on the right of the footer's directory row, directly
above the model name. Recording does not add a separate row.

Python 3 runs Python tools/drivers; uv is needed to prepare or repair their default
environment, and ffmpeg is needed for video encoding. Discovery does not create
Python. Kinex prepares `.kinex/python` when its interpreter is missing; existing
environments run without syncing. The ordinary shell environment stays unchanged.

## Commands

| Command | Behavior |
| --- | --- |
| `/devices` | List device types and loaded intent. |
| `/load <device|all>` | Load a device and await initialization. |
| `/unload <device|all>` | Stop capture, release the device and its owned resources. |
| `/reload <device|all>` | Restart device drivers. Bare `/reload` reloads agent resources. |
| `/ping <device|all>` | Inspect existing services without starting them. |
| `/stop [device]` | Cancel the current agent response and stop loaded actuators. |
| `/unregister <device>` | Confirm, unload, and delete the device's local files. |
| `/record start arm=10 camera=2` | Start recording with per-device rates. |
| `/record snap <devices>` | Capture an observation. |
| `/record stop [success|failure|partial] [summary]` | Finish a recording. |
| `/record status` | Inspect current and recent recordings. |
| `/onboarding [description]` | Prepare the embodiment and current task through a setup DAG. |
| `/register <type-or-template>` | Ask the model to prepare an unloaded profile. |
| `/calibrate [scope]` | Resolve only the selected calibration prerequisites. |
| `/mode [ask|auto|yolo]` | Select the Kinex permission/interaction mode. |

Device names complete with Tab. General coding commands and keybindings use Pi's
TUI: `/model`, `/login`, `/settings`, `/new`, `/resume`, `/tree`, `/fork`, `/compact`,
`/export`, `/copy`, `/quit`. Some SDK help and diagnostics retain Pi terminology.
Use `kinex --continue` or `kinex --session <id|file>` to resume Kinex sessions.

The `device` and `record` model tools default to `verbose: true`, preserving all
result fields. `verbose: false` omits declared empty optional fields, preserving
faults, timestamps, zero/false values and unknown driver fields. Manual `/record`
defaults to this cleanup; add `--verbose` immediately after its action for full
output, for example `/record status --verbose` or `/record start --verbose arm=10`.
All Kinex tool JSON results in the TUI indent their first two levels by two spaces
and keep deeper values inline, including Python and workspace tools. Python tool
returns and calibration samples use the same formatting in model context.
The device tool's `compact` option still requests single-line JSON.

Sensor and actuator readings now use numeric `timestamp` in seconds. Update custom drivers
and consumers together; no old-field aliases are supported. Refresh exported/copied
drivers and runtime resources, then reload devices and restart owned RoboEnv services.
UUID-based IDs now use 16 random hexadecimal characters (with existing prefixes).

Setup tracks an agent-authored DAG with `setup_plan`; only the current task's
prerequisites advance. Unrelated calibration remains deferred, and incomplete
onboarding never gates device operations. Existing operation checks and permissions
still apply. `calib_sample` archives attempt evidence; `calib_compute` runs offline
solvers and proposes profile changes. See [setup API and migration](packages/setup/README.md).

Direct operations run without a model round trip. Only onboarding, registration
and calibration submit workflows to the model. Core owns registration, unregister,
provisioning and device guides. Setup owns onboarding and calibration; standalone composes both contributions. Core alone
can add, remove and operate devices, including control, perception and recording.

## Control and world time

Writes submit an action buffer with `duration_s` and return immediately.
Gripper and suction use flat `actions: [value, ...]`; joint devices and dexterous
hands use `actions: [[joint1, joint2, ...], ...]`. A single command uses one action.
Use `device("world", "wait", duration_s=...)` for delays in the driver's clock.
`servo` plans and submits a full joint trajectory, returning immediately with
`device`, the driver's `execution_id`, requested/IK-resolved target `joints`,
computed `duration_s` and `actions_submitted`. It accepts no duration override.
Use `world.wait` to allow execution time and measured feedback to verify arrival;
neither submission nor elapsed duration confirms arrival. Position devices retain
the final reference.
`track` composes perception, processing, control and an `until` predicate, waiting
`wait_s` each round. This is its observation/replanning interval: a new control
call can replace the remaining references, and exit or `stop_after_control` can
interrupt a plan.

For existing servo calls, remove the `duration_s` argument; obsolete input is
rejected. The returned duration now comes from the planner. Device writes and
`run_policy` keep their existing duration behavior.
Servo results expose `execution_id` directly; the nested `write` and `end_joints`
fields have been removed. Driver feedback validation still runs before success.

`device` calls one device; `devices` accepts a batch of calls:

```json
{"calls": [{"deviceID": "camera"}, {"deviceID": "arm"}]}
```

A workspace perception tool `target_pose` can return `{frame, pose}`. This
composition transforms that full pose into the arm frame and tracks it:

```json
{
  "world": "world",
  "wait_s": 0.1,
  "perceive": {"tool": "target_pose"},
  "process": {
    "tool": "relative_pose",
    "args": {"parent": {"frame": "arm"}},
    "inputs": {"/child/frame": "/frame", "/child/pose": "/pose"}
  },
  "control": {
    "tool": "servo",
    "args": {"device": "arm"},
    "inputs": {"/pose": "/pose"}
  },
  "until": {"tool": "settled", "args": {"timeout_s": 10}},
  "stop_after_control": false
}
```

Without `inputs`, process receives `observation` and its returned dict overrides
controller arguments. With `inputs`, JSON Pointer mappings select the fields.
Null results or selected null values count as misses; missing paths are errors.
`relative_pose` uses `{frame, pose?}` for both endpoints; local poses default to
identity. Input and returned poses use `[x,y,z,qx,qy,qz,qw]`, with translation in
metres and a unit quaternion in xyzw order. Results contain only `pose`, `path`
and `estimated_links`; the duplicate `translation` and `rotation` fields have
been removed. Pass the returned `pose` directly to `servo.pose`.

Any stage can use inline Python instead of a tool name, without creating files
or waiting for discovery. For a previously measured target in the arm frame:

```json
{
  "world": "world",
  "wait_s": 0.1,
  "perceive": {
    "python": "lambda target: target",
    "args": {"target": {"pose": [0.3, 0, 0.2, 0, 0, 0, 1]}}
  },
  "process": {"python": "lambda observation: observation"},
  "control": {"tool": "servo", "args": {"device": "arm"}},
  "until": {"tool": "settled", "args": {"timeout_s": 10}}
}
```

`python` accepts a lambda or source defining `main`, including imports and helper
functions. Functions receive keyword arguments and return JSON data directly.
Each call runs in a fresh Python process with the caller's interpreter and working
directory. Runtime transfers arguments and results through JSONL pipes. Inline
control may command devices; the other inline stages have perception capabilities.
Until receives `context` and `state`, returning `done`, optional `state` and `reason`.

Replace perception/processing with live observation tools for closed-loop control.
`stop_after_control` stops owned motion after each world wait; track always stops
owned motion on exit. `settled` checks measured joint error and quiet velocity
for a stable interval in world time, accepting only fresh device timestamps as
arrival evidence. Cached samples cannot establish arrival. Changing the target
restarts stability but preserves the optional world-time timeout.

`run_policy` infers once and submits an action chunk. If IK fails partway through,
all commanded devices receive the shared valid prefix at the original `action_hz`.
The result includes `ik_failure` with `device`, zero-based `action_index` and
`error`, or null when no IK failure occurred. IK rejection returns normally, so
`track` waits and continues. An empty prefix submits nothing and leaves existing
buffers intact. Results contain `actions_submitted`, `duration_s`, `execution_ids`
(device to execution ID) and `ik_failure`. Migrate consumers of the former `writes`
map to `execution_ids`; use fresh reads for measured state. Structured failures,
including `stop_failed`, preserve `error`, `code` and `details` across tool calls
and remain failures rather than normal IK truncations.

Numerical IK now retries failed DLS solves from deterministic nearby and broader
seeds, choosing the valid fallback nearest the original seed. An initial solution
still returns immediately. Optional `intrinsics.kinematics.ik.search` defaults to
`{max_attempts: 5, attempt_time_s: 0.02, max_time_s: 0.1}`; `max_iterations`
also limits each attempt. These cooperative budgets apply per pose, so policy
chunks can accumulate planning time. Tolerances and FK checks remain strict;
nearest preference does not impose a hard waypoint-step limit. See the
[core API](packages/core/README.md) for details.

Existing profiles inherit the defaults without migration. After upgrading core,
reload persistent drivers. If a workspace's `.kinex/lib/kinex` overrides packaged
Python helpers, refresh those copies together, including `kinematics.py` and
`ik_search.py`, before reloading. Native plugins require their separate packed
core snapshot update.

For receding horizon control, set `run_policy.max_actions` to the maximum number
of actions to execute from each inference. The remaining predictions are discarded
before validation and IK; each call infers a new chunk. Omit `max_actions` to use
the whole chunk. For example, `max_actions: 10` and `action_hz: 20` submit at most
0.5 seconds of actions. Compose this controller with fresh observations in `track`
and `wait_s: 0.5` to replan after that window. A shorter wait replaces pending
actions sooner; IK rejection or a shorter inferred chunk can reduce the submitted
duration without changing `track.wait_s`.

## Headless

```sh
kinex run --auto "Inspect the workspace and read the loaded sensors"
kinex run "/devices"
kinex run "/load camera"
kinex run --auto --record "arm=10 camera=2" "Perform the task"
kinex run --auto --json "Inspect the workspace"
```

Use `--model provider/model`, `--thinking high`, `--continue`, or `--session` as
needed. `--effort` is an alias of `--thinking`. `--seed` submits an initial prompt
in interactive mode. Each headless process releases its drivers when it exits;
`loaded` intent persists and is restored by the next process.

`--record` reports refused streams to stderr. Valid streams continue recording,
and the task still runs if every stream is refused, including with `--json`.

Export a saved session with `kinex --export session.jsonl [output.html]` without
model credentials or a robotics runtime. The default output is
`pi-session-<basename>.html` in the current directory. Export preserves the source
session, including older formats, and rejects output paths referring to that file.

## Configuration and permissions

Kinex uses separate storage from Pi and from legacy Kinex coding sessions:

| Path | Contents |
| --- | --- |
| `$KINEX_CONFIG_DIR/agent/settings.json` | Pi-format coding settings. |
| `$KINEX_CONFIG_DIR/agent/models.json` | Pi-format custom providers and models. |
| `$KINEX_DATA_DIR/agent/auth.json` | SDK credentials. |
| `$KINEX_DATA_DIR/agent/sessions/` | SDK JSONL sessions, grouped by workspace. |
| `.kinex/agent/settings.json` | Project coding settings. |
| `.kinex/kinex.json` or `kinex.json` | Existing core permissions and recording settings. |
| `.kinex/devices`, `tool`, `skill`, `recordings` | Existing robotics workspace content. |

The global defaults are `$XDG_CONFIG_HOME/kinex` (`~/.config/kinex`) and
`$XDG_DATA_HOME/kinex` (`~/.local/share/kinex`). Kinex's launcher sets Pi's documented
agent-directory override to the Kinex configuration directory. It does not use
`.pi` settings, extensions, skills, or system prompts. Project `AGENTS.md` and
`CLAUDE.md` instructions are loaded through the SDK. External Pi packages/resources
in agent settings are not supported in this first standalone delivery; use Kinex's
workspace tools and skills. Legacy coding settings, command templates and session
formats are not migrated.

For a local model, for example, `agent/models.json` can contain:

```json
{
  "providers": {
    "local": {
      "api": "openai-completions",
      "baseUrl": "http://localhost:11434/v1",
      "apiKey": "local",
      "models": [{ "id": "your-model-name" }]
    }
  }
}
```

Then select `local/your-model-name`. Model settings use Pi's format directly; Kinex
does not maintain a second provider implementation.

| Mode | Tool permissions | User questions |
| --- | --- | --- |
| Default interactive | Core rules; ask when unresolved | Enabled |
| `--auto` | Automatically allow | Enabled in the TUI |
| `--yolo` | Automatically allow | Disabled |
| Default headless | Core rules; deny unresolved asks | No interactive answers |

These are Kinex policies implemented using SDK hooks, not Pi-native CLI flags.
Write, edit and bash use the same allow/ask/deny rules as robotics tools; `shell`
is the permission name for bash. Approval can be once or for the session. Auto
modes override configured denies, matching the previous Kinex behavior. Stop is
always allowed. The model's `record` tool is available only with
`--enable-recording`; manual `/record` is always available. Unregister still needs
an explicit interactive confirmation. The profile-writing tool and permission are
now named `profile_write`; migrate existing `permission.calib_write` rules to
`permission.profile_write`. The old name is not an alias. Tool approvals do not provide an OS sandbox.

## Runtime behavior

- A workspace owns the robotics runtime; a chat session does not own its drivers.
- New/resumed/forked sessions in the same workspace retain connections, cancel old
  calls, reset grants and finalize current recording. Switching workspace or
  quitting disposes drivers and subprocesses. Resource reload also finalizes recording.
- Core skills and tools keep workspace/global/builtin discovery precedence. After
  each completed tool batch, new/changed tool schemas and skill catalogs are
  available to the next model request, including headless runs without further
  user input. Edits to an existing tool's implementation or skill body are picked
  up on its next invocation. No file watcher wakes an idle or finished task.
- Stable instructions and tools remain stable. Changed runtime state is appended
  to the active conversation branch. Manual and automatic compaction include
  robotics summary requirements and restore a full current snapshot before the
  next model request. If snapshot recovery fails, work stops until it succeeds.
  Pi handles native tool additions where the model supports them; unsupported
  models and tool interface redefinitions can change the cached prefix. This is
  verified with local request fixtures, not measured live cache-hit rates.
- A tool batch containing any core/setup tool or question executes in order, including
  mixed coding/robotics batches. Permission denial or cancellation stops later
  calls; completed work is not rolled back. Pure coding batches remain parallel.
- Images enter SDK history as bytes; replacing the source file does not change
  replay. Recording traces omit opaque provider reasoning and image bytes.
- UI loaded counts describe activation intent. `/ping` checks live service state.

See [DESIGN.md](DESIGN.md), [the core API](packages/core/README.md) and the
[refactor progress](PLAN.md).

## Checks and packaging

```sh
python3 -m pip install -r packages/core/test/requirements.txt -r packages/setup/test/requirements.txt
npm run typecheck
npm test                         # fake provider, CLI/package, real Linux/macOS PTY
npm run test:core                # core and independent npm consumption
npm run test:setup               # onboarding/calibration and setup removal
npm run test:tui                 # after build
```

Tests use mock devices and a local HTTP provider; no paid model API is needed.
PTY tests need Python 3 and a POSIX host; camera and solver tests need Pillow and NumPy in
the `python3` interpreter (activate a virtual environment before installing the test
requirements if needed). Do not rebuild core while consumer tests
are running. Live provider cache rates and real robot task success require separate
environment-specific validation.

After building, pack standalone, core and setup with:

```sh
npm run pack -- /tmp/kinex-release
```

Until registry publication, install standalone with both package dependencies:

```sh
npm install /tmp/kinex-release/kinex-core-0.9.0.tgz \
  /tmp/kinex-release/kinex-setup-0.9.0.tgz \
  /tmp/kinex-release/kinex-0.9.0.tgz
```

GitHub CI checks types, core, setup and standalone, including PTY interaction and package
relocation. CI uses `.nvmrc` and Python 3.12; no physical devices or paid models.

A `v*` tag must match the standalone, core and setup versions and their exact dependencies.
Before tagging, update all three package manifests, exact internal dependencies,
lockfile, CLI version and installation examples. Run
`node script/release.mjs --check --tag v0.9.0`, complete the checks above, and commit
the version changes before creating the tag. Release CI reads the tagged commit;
rerunning an existing tag does not pick up later commits.
Release CI publishes three npm tarballs plus `SHA256SUMS` as GitHub assets. It does
not publish to npm or bundle Node. Routine builds/tests publish nothing.

## Use Kinex in another harness

Pi, OpenCode and Codex plugins are maintained in the separate
[`kinex-plugins` project](../kinex-plugins/README.md), with independent installs,
SDK versions, tests and releases. They consume a versioned `@kinex/core` tarball
and do not require standalone Kinex or a source checkout. Their core snapshot is
updated explicitly; robotics code is maintained only in this repository.

`@kinex/core/integration` defines feature contributions for tools, skills, commands
and namespaced context. Host adapters consume contributions; product entrypoints
explicitly compose them around a shared runtime. Standalone explicitly includes
`@kinex/setup` for onboarding and calibration. Core owns registration, unregister,
device provisioning and operation; it can be installed alone. See [setup composition and API migration](packages/setup/README.md).
Native plugins still use their existing packed snapshots; adopting these new APIs
and packaging setup is a separate update in that project.

Joint reads contain positions, velocities, efforts, faults and timestamp. Use FK
to obtain poses, selecting `frame` and `reference_frame` (null means device base).
Profiles define local frames with `parent_frame`, `translation_m` and
`rotation_xyzw`; null transform components mean unknown. Joint `kinematics.frame`
and hand geometry declare computed frames directly; omit their duplicate entries
from `frames`. Frame queries compute FK on demand.

Camera reads save RGB/depth files and return their paths in JSON. Use Pi's built-in
`read` tool on the RGB path when image inspection is needed.

Python tools can select camera output with `device("camera", output="array")["data"]`
for NumPy `color`/`depth` arrays, or `output="base64"` for PNG/PGM16 strings.
The default `output="file"` returns saved paths. Each mode includes one `timestamp`.
This selects driver output, independently of the camera server's transport.

Velocity writes use named axes, for example
`{mode: "drive", velocity: {vx: 0.05, vy: 0, wz: 0}, duration_s: 0.5}`.
Consult the profile for units and input bounds. Velocity reads expose measured
velocities, faults and timestamp, plus available body/local-frame measurements;
they omit global pose. World-relative transforms require explicit frame estimates.
Existing velocity profiles must remove `feedback.pose_frame`; drivers must omit
`pose` from both reads and write-result states.
Refresh copied RoboEnv profiles and drivers together, restart the simulation service,
and reload the base after upgrading an existing workspace.

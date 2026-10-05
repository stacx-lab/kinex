# @kinex/core

Kinex's robotics runtime for Node >=22.19. The standalone Kinex agent
uses this package directly; external host adapters can consume the same API.
It contains no model provider, agent loop, session store, terminal UI or MCP server.
Core provisions, registers, removes and operates devices independently of
`@kinex/setup`. It includes device guides, driver templates, setup-device, lifecycle,
control, perception, kinematics, recording and runtime Python.
Onboarding and calibration procedures live in
[`@kinex/setup`](../setup/README.md).

```ts
import { createKinexRuntime } from "@kinex/core"

const runtime = createKinexRuntime({
  directory: process.cwd(),
  host: {
    ask: async (request) => { /* await the host's permission decision; throw on denial */ },
    questions: async (questions) => { /* use the host's question UI */ return {} },
  },
})
try {
  // Python is created lazily when an internal operation needs it.
  const activations = await runtime.devices.warmLoaded()
  // Observe each activation.ready for background loading failures.
  const { tools, problems } = await runtime.tools.list()
  // Register schemas with the host and route each invocation to tools.call.
  const context = await runtime.context()
  const result = await runtime.tools.call("device", { deviceID: "camera" }, {
    sessionID: "host-session", callID: "host-call", signal: new AbortController().signal,
  })
  // result includes text, error status, metadata and optional image file paths.
} finally {
  await runtime.dispose()
}
```

The permission callback is the authorization boundary. It must resolve only when
allowed and throw `PermissionDeniedError` when denied. With no host callbacks,
permission requests other than stop are denied and questionnaires are declined. Model tools keep
the existing device permissions. The device tool supports load/unload through
`device_act`; Python tools cannot change lifecycle. The `devices` lifecycle
methods and `profiles` methods are trusted host operations: expose them through
user commands, not unrestricted model tools. `enableRecording: true` exposes the
model's recording tool; the host can use `recording` methods independently.

## Shared user commands

The root exports `roboticsCommands`, `isRoboticsCommand()` and
`executeRoboticsCommand(runtime, name, arguments, context)`. The catalog provides
names, argument hints and descriptions for devices, load, unload, reload, ping,
stop, record, register and unregister. Operations return
`{kind: "output", text, isError?}`. Register returns `{kind: "workflow", prompt}`
for the host to submit to its model; it prepares an unloaded device using core's
setup-device skill and profile_write tool. Hosts provide a session ID, command
context and optional progress notifications, and own display and cancellation
for stop. Unregister uses the CommandContext confirmation callback before deleting
a device. This executor is a trusted user-command API.

## Feature contributions

`@kinex/core/integration` exports `KinexContribution`, `KinexCapabilities`,
`ContributionCommand`, `Invocation`, `ToolSchema`, `coreContribution(runtime)` and
`composeContributions(contributions)`. This is a host-independent capability
interface, not a second runtime or a dynamic extension loader.

```ts
import { coreContribution, composeContributions } from "@kinex/core/integration"
const capabilities = composeContributions([coreContribution(runtime)])
// Add setup explicitly when onboarding/calibration is needed; see @kinex/setup.
const catalog = await capabilities.tools.list()
const state = await capabilities.context() // stable instructions + source.section keys
```

A contribution can provide tools (`list`/`call`), skills (`list`/`load`), commands
and context. Tools receive `Invocation` with session/call identity, abort signal,
permission and question callbacks. Commands receive a distinct trusted
`CommandContext`, including an optional abort signal. Load/reload also accept an
optional signal. Each feature must preserve authorization/cancellation internally.
Duplicate identifiers are errors; tool directories are re-read when calling.
A contribution borrows resources; the product that created the runtime disposes it.
The existing root APIs remain available without adopting contributions.

## Device calls and control

`device` calls one device; `devices` accepts `calls: [{deviceID, action?, args?}]`.
Batch permissions are checked before dispatch. Calls run concurrently under each
device's scheduler; results stay in input order and report individual errors.
Camera files are attached as images. Sampling is not simultaneous and effects
are not atomic. Python tools may compose these tools without gaining lifecycle
or controller capabilities.

Actuator writes submit validated buffers with `duration_s` and return immediately.
Devices consume them at their fixed cadence. Position devices retain the last
reference; velocity devices expire to zero velocity while retaining posture.
`world.read` returns `time_s`; `world.wait(duration_s)` waits on the driver's clock.
Reads may also include `budget: {elapsed_s, max_s}`: episode time consumed and
allowed, in seconds. `elapsed_s` is finite and nonnegative; `max_s` is finite and
positive, or `null` for no cap. Omission means the driver supplies no budget.
The information is reported as supplied, even if elapsed time exceeds the allowance;
Kinex does not infer it from `time_s`, enforce it, or change control behavior.
Wait results remain `{time_s, elapsed_s}`, with elapsed time for that wait only.
Drivers must convert native counts to seconds before reporting a budget. Legacy
`used`, `max` and `unit` members are rejected, as are malformed budget objects.

- `servo` plans and submits a full joint trajectory from measured state. It
  accepts joints or a pose and returns immediately, with no duration input.
  Results report computed `duration_s`, requested/IK-resolved target `joints`, and
  final commanded reference `end_joints`. Continuous-joint references may differ
  from the target by a full revolution. These are plan information, not measured
  arrival: allow execution with `world.wait` and verify using feedback. Planning
  defaults are 1 rad/s and 3 rad/s², or 0.1 m/s and 0.3 m/s² for linear joints,
  capped by known limits. Lower `speedFraction` lengthens the computed duration.
- `run_policy` infers once, splits the selected chunk across devices, and submits
  buffers concurrently. Cartesian `pose` and `pose_delta` actions use frozen
  reference frames and seeded IK; `target_frame` must be rigidly attached to the
  IK frame. It returns submission results without waiting.
  Gripper/suction writes use flat `actions: [value, ...]`; joint and dexterous-hand
  writes use sequences of joint vectors. Both require `duration_s`.
- `relative_pose` accepts `child` and `parent`, each `{frame, pose?}`. A local pose
  is `[x,y,z,qx,qy,qz,qw]` in metres with a unit quaternion, defaulting to identity.
  Both local transforms participate. The result expresses child in parent and
  includes `translation`, `rotation`, `pose`, `path` and `estimated_links`.
  Shipped joint IK, `servo`, `run_policy` and `relative_pose` normalize xyzw
  quaternions with norms in `[0.999, 1.001]`, including frame estimates. Values
  outside that range are rejected with the received norm. Persisted profiles
  and velocity readings retain their stricter validation.
- `track` composes perceive → process → control → world.wait → optional stop → until.
  Process receives `observation` and returns a dict that overrides `control.args`.
  Optional `inputs` on process/control maps destination argument JSON Pointers
  to source paths in the preceding result. With mappings, only selected values
  are injected. Null results or selected null values count as misses; missing
  paths are errors. `settled` checks arrival and optional world-time timeout.
  Each stage accepts either `tool` or `python`, alongside the same `args` and
  mappings. Inline Python is a lambda or source defining `main`; it receives
  keyword arguments and returns JSON data without calling `finish`.

For a workspace perception tool returning `{frame, pose}`:

```python
call("track", world="world", wait_s=0.1,
     perceive={"tool": "target_pose"},
     process={"tool": "relative_pose", "args": {"parent": {"frame": "arm"}},
              "inputs": {"/child/frame": "/frame", "/child/pose": "/pose"}},
     control={"tool": "servo", "args": {"device": "arm"},
              "inputs": {"/pose": "/pose"}},
     until={"tool": "settled", "args": {"timeout_s": 10}})
```

For a fixed target, use `perceive={"python": "lambda target: target", "args":
{"target": {"frame": "arm", "pose": [0.3, 0, 0.2, 0, 0, 0, 1]}}}`.
Inline stages bypass discovery and run in fresh subprocesses through the existing
JSONL dialog, inheriting the caller's interpreter, working directory and deadline.
Only inline control has controller capabilities. Until state is passed explicitly
between rounds. Python tools can also use `inline(source, values, kind="perception")`;
requesting controller capability requires a controller caller.

Track stops owned motion on misses, errors, cancellation and final exit.
`stop_after_control` also stops it after each round's wait. Cleanup cannot stop
another invocation's replacement. Uncertain writes are never retried.
`wait_s` is the observation/replanning interval; a new control call can replace
the remaining references of a full servo plan before it completes.

Migration: remove `duration_s` from servo arguments; obsolete input is rejected.
The Python `kinex.trajectory.trajectory(...)` helper also removes its `duration_s`
keyword and now returns a `Trajectory` dataclass instead of a reference list.
Use `plan.actions` and `plan.duration_s` together when submitting a device write.
Device writes and `run_policy` retain their existing duration contracts.

## Public runtime

- `tools.list()` returns input JSON schemas plus discovery problems; defaulted
  arguments remain optional for host validation. `tools.call()`
  rescans, validates arguments, checks permissions and returns normalized results.
- `skills.list()/load()` and `context()` provide discovered skills and live robotics
  context (shared instructions, type conventions, guide roots, readiness and Python environment)
  for the host's prompt. Python context includes `library` and `workspaceLibrary`
  paths for shells that need an explicit `PYTHONPATH`. Core does not edit the
  host's system prompt.
- `devices.warmLoaded()` restores already-loaded devices once per runtime and returns
  activation handles after reserving their initialization lanes. Await each `ready`
  for completion; failures remain per device. Disposal cancels pending initialization.
- `python.status()/initialize()/prepare({signal})` inspect, seed and synchronize the
  separate `.kinex/python` project. Status is read-only; initialize installs nothing.
  The project may be absent. Default Python execution prepares it only when the
  interpreter is missing; otherwise it runs directly, even if dependency declarations
  have changed. Explicit `prepare()` always synchronizes. Concurrent first use within
  a process waits for preparation; failed bootstraps can retry without accepting a partial environment.
  Preparation returns the interpreter and child-process environment.
- `devices.list()/load()/reload()/unload()/ping()` implement
  user device commands. Load/reload returns `{device, activating, ready}`; await
  `ready` for background initialization. `devices.dispatch()` is a trusted driver API.
- `devices.templates()` discovers provisioning instances and type templates.
  `devices.unregister(name, signal?)` holds the device lifecycle fence through
  capture shutdown, deactivation and deletion, including associated calibration
  result files. Failed deactivation preserves device files. This trusted method
  does not prompt; the `/unregister` command confirms through its host.
- `profiles.snapshot()/writeManifest()/writeDevice()` and `readiness()` expose
  workspace state. Profile writes validate using the existing schemas.
- `recording.start()/snap()/stop()/status()/recent()` manage recording products.
- `subscribe()` observes device, tool execution and recording events and returns an
  unsubscribe function. Listeners run synchronously and must not throw or block.
- `observe()` accepts host message boundaries for recording attribution. Optional
  `host.exportTrace(sessionID, range)` supplies a host-specific transcript snapshot;
  without it, recording has no transcript dependency or delayed export wait.
- `dispose()` is idempotent. It cancels active tool/device calls, finalizes recordings,
  waits for transcript export and closes child processes. Hosts must call it on
  workspace switch/shutdown. Custom tools must honor their abort signal.

Construction/import does not connect to hardware, write files, or install process
handlers. Each runtime owns its driver connections, dispatch lanes, mock state,
observers, model cache and recorder. Separate runtime instances isolate in-memory
state even when device names match. Disk profiles remain shared when the directory
is shared; use separate workspaces for independent persistent state.
URDF parsing is shared within a runtime. Cancelling a caller releases its wait;
runtime disposal cancels the shared parser and releases its process.

`run()` binds low-level calls and their asynchronous work to a runtime scope.
Standalone and extension integrations should prefer bound runtime methods.
Exported subpaths support internal Kinex consumers; the root runtime API
is the intended integration surface.

Onboarding and calibration use `createKinexSetup(runtime)` and
`setupContribution(setup)` from `@kinex/setup`. Core retains registration workflows
at `@kinex/core/workflows/index`, template discovery and unregister.
`runtime.readiness()` and dynamic context report profile completeness and
prerequisite status without procedural calibration guidance.

The core model tool `profile_write` writes workspace facts (`kind: robot`), device
profiles (`kind: device`) and calibration-request markers (`kind: needed`). It
preserves validation, merge/replace semantics, provenance and explicit marker
clears. New devices remain unloaded; edits preserve activation intent. The trusted
profile API remains available for hosts. The tool requests `profile_write`
permission, whose core resolver default is `allow`; explicit rules and host
callbacks still apply.

Migration: replace `calib_write` calls with `profile_write` and move configured
`permission.calib_write` rules to `permission.profile_write`. No alias is provided.
Replace `setup.devices.templates/unregister` with `runtime.devices.templates/unregister`;
setup's device facade is removed. Workspace formats are unchanged.

`runtime.operation(fn, signal?)` tracks a trusted feature operation in the runtime's
scope and supplies a combined cancellation signal. `runtime.tools.execute(def, input,
invocation)` runs a feature tool through validation, permissions, cancellation and
recording attribution. These are trusted host composition APIs, not model tools.
Invocation permission/question callbacks take precedence over runtime host defaults.
`Def.recordingOrigin: "agent"` identifies direct device traffic for the recorder;
other tool traffic retains its tool name.

## Assets and discovery

`assets/` owns device provisioning bundles (including FastWAM, SAM3 and
GroundingDINO), template drivers, complete Setup/Profile/Use guides, setup-device,
operational Python tools and runtime helpers. Assets resolve relative to the
package. Only each loaded type's Use section enters normal runtime context;
Setup/Profile is read when needed. Setup ships calibration skills separately.
Copy drivers and their runtime support files into device workspaces when provisioning.

Discovery preserves workspace/project → parent projects → global → built-in
precedence. `RuntimeOptions.builtinSkillRoots` appends feature-package skill roots
to the builtin tier; discovery scans local/global roots only once.
`RuntimeOptions.reservedToolNames` keeps feature builtin names ahead of discovered
custom tools, reporting conflicts. TypeScript and JavaScript custom tools reload on discovery through
Jiti. Tools can retain Zod schemas; Python tools keep raw JSON Schema parameters. Workspaces supply any dependencies imported by custom
tools. This code is trusted executable workspace content, like standalone Kinex.

Python and uv remain external. Core owns `.kinex/python/{pyproject.toml,uv.lock,.venv}`
per workspace; it never adopts the ordinary Python project. Default drivers/tools,
URDF inspection and camera encoders use it; explicit interpreters are supported.
Use `uv add --project <python.project> PACKAGE` for driver dependencies, substituting
the discovered project path from context (including when working below the workspace
root). Host shells remain generic; core context supplies guidance for selecting its
Python explicitly. Existing root environments are left untouched. Video encoding requires ffmpeg.
uv is not needed to execute an already prepared environment. Import/discovery needs
neither Python nor uv. Missing packages report errors without automatic installation
or replay of the failed tool.

## Development

Python tools receive one startup JSON line on stdin: `{"args": {...}}`, with
`"source": "..."` added for inline Python. The client consumes it before any RPC;
tool code continues to use `kinex.args()`. One-shot drivers receive
`{"action": "read", "args": {...}}` followed by EOF; `kinex.driver_protocol.run`
handles this and the existing persistent protocol. Custom scripts parsing payloads
from `sys.argv` must migrate to these helpers. Executable paths and `--serve` stay
in argv; payload size no longer selects a transport.

Images stay in files. For example, perception can return
`{"image": device("camera")["file"]}`; with an identity processing stage, the
controller mapping `"inputs": {"/observation/images/0": "/image"}` passes the
current file path each round. Consumers open the file, and image tools can display
it to the model. No image bytes need to appear in generated tool arguments.

From the repository root:

```sh
npm ci
npm run build:core    # Node ESM + declarations, including text modules
npm run test:core     # real Node tests and npm tarball installed outside the repo
npm run typecheck
npm test             # standalone regression suite
npm run build        # core, setup and standalone
```

Node loads `dist/`. Build the core before
packing it. No package is published by these commands. The standalone CLI and Pi
TUI also support Node 22.19 without OpenTUI FFI. This first delivery provides npm
tarballs; self-contained Node releases are deferred.

`@kinex/core/permission/index` exports rule validation and `kinexPermissionPolicy`
(defaults and always-allow stop) plus `kinexPermissionAction` for host adapters.
`loadTools(directory, {additionalTools, enableRecording})` composes the single core
catalog with host tools; recording is omitted unless explicitly enabled. Host tools
and core builtins precede discovered custom tools, with conflicts reported.

Device observations and recording can run during bounded writes. Writes are ordered
per device; independent devices can write concurrently through `devices.dispatch`
and Python `devices()`. Stop interrupts its declared device scope and rejects older
queued writes. Load/unload/reload fence connections and capture ownership.
Persistent drivers must echo request IDs and permit out-of-order replies; migrate
custom loops using the shipped `kinex.driver_protocol.run` and reload devices.

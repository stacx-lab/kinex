# Design

Kinex combines an operational robotics core and optional setup features with
standalone and native-host entrypoints.
Hardware and simulators share the same device contracts.

## Structure

| Location | Owns |
| --- | --- |
| `packages/core/src`, `packages/core/assets` | Configured-device runtime, schemas, validation, operational Python/tools and Use conventions; no setup/agent/UI dependencies. |
| `packages/setup` | Provisioning, onboarding, registration/unregister, calibration tools, procedures and assets; depends on core. |
| `src` | Standalone CLI, isolated coding storage and product policy; published Pi SDKs supply the coding harness and TUI. |
| `src/integration` | Standalone Pi integration and product policy, independent of native plugins. |
| `../kinex-plugins` (separate project) | Native Pi, OpenCode and Codex integrations consuming a packed core snapshot. |

`KinexContribution` exposes tools, skills, commands and context. Products explicitly
compose contributions; adapters translate host APIs. Compatible feature changes
flow through these catalogs without per-feature adapter code. New interaction or
lifecycle semantics still require adaptation. Standalone composes core and setup by
default. Core-only consumers retain all
utilities needed to operate a configured inventory, including lifecycle, transforms,
kinematics, perception, control, recording and lazy Python preparation. Setup borrows
the runtime through tracked operations/tool execution; the runtime owns cancellation,
recording attribution and disposal. Unregister lives in setup and holds core's device
transition fence through deactivation and deletion.

## Core contracts

- **Runtime and discovery.** Construction is inert; bound operations share a
  workspace resource scope. `warmLoaded()` reserves initialization lanes; disposal
  cancels operations, finalizes recording and closes owned processes. Runtimes
  isolate memory, while a workspace shares disk state. `.kinex/workspace.yaml`
  describes the assembly; `devices/<name>/profile.yaml` defines inventory. Content
  precedence is nearest project → ancestors → global → packaged assets. Read-only
  discovery must not create a nearer workspace and change that precedence.
- **Devices and control.** Types describe interfaces; profiles separate access,
  intrinsics and extrinsics. Drivers alone own SDK connections, units and cleanup;
  dispatch preflights commands once before admission and observes traffic; drivers
  validate again at the device boundary. A per-device scheduler replaces prior motion.
  Reads run alongside writes; independent devices write concurrently. Stop
  interrupts affected commands and clears their queued writes. Lifecycle
  transitions fence resource users before releasing connections.
  Persistent drivers use JSONL; one-shot drivers read one `{action,args}` stdin
  line and release temporary clients. Core
  includes a mock, not a simulator engine. User commands or permission-checked
  model tools control lifecycle; Python tools cannot. `loaded` is intent, not
  readiness; ordinary calls never restart failed services. Stop bypasses approval.
  Unload attempts capture shutdown, stop and resource release; borrowed services
  are not terminated. Joint goals are absolute vectors in model order, in radians/metres.
  All actuator writes submit a validated buffer with `duration_s` and return
  immediately with `execution_id`, submission `elapsed_s` and measured `state`.
  Gripper and suction actions are flat numeric sequences; joint and dexterous-hand
  actions are sequences of joint vectors. One command is a one-element sequence.
  New writes replace pending references without stopping; invalid writes leave
  them intact. Devices consume buffers at their fixed cadence. Position commands
  retain their final reference; velocity commands expire to zero velocity while
  preserving posture. Explicit stop clears affected buffers. Background faults
  remain visible through reads. Ownership outlives write calls; cleanup cannot
  stop a replacement owned by another invocation.
  `world.read` returns `time_s` and optional `budget: {elapsed_s, max_s}`. Budget
  values are episode time in seconds: finite nonnegative elapsed time and a finite
  positive allowance, or `max_s: null` for no cap. Drivers own accounting and
  conversion to seconds; Kinex neither infers a budget nor enforces its allowance.
  `world.wait(duration_s)` returns only `time_s` and actual `elapsed_s` for that
  wait. Drivers abstract physical and simulated clocks. Concurrent
  waits share world time and support individual cancellation. Reads never advance
  time. Uncertain writes are never retried automatically.
- **Frames and calibration.** Frames form a forest; world is optional and missing
  relationships are not identity transforms. `relative_pose` composes full local
  poses attached to its child and parent frames, using declared,
  live and call-local estimated edges, preferring fewer estimates; samples are
  cached only within a call. `???` is unresolved; `null` follows field semantics.
  Calibration writes are validated and planning is read-only. FK/IK uses declared
  geometry or driver solvers; readiness, world bounds and IK do not certify safe
  or collision-free motion.
  Shared Python pose validation and call-local frame estimates normalize xyzw
  quaternions only when their norm is within `[0.999, 1.001]`, inclusive.
  Persisted-profile schemas and velocity-reading validation remain strict.
- **Tools, skills and Python.** Tools declare schemas, capabilities and timeouts;
  composed calls retain permissions and recording attribution. Skills supply
  procedures. Detection/segmentation feed perception; depth localization respects
  masks and reports camera-relative measurements. `servo` plans from measured
  joint positions and submits a full trajectory at its computed duration, without
  waiting, stopping, settling or arrival checks. It accepts no duration override;
  results report computed `duration_s`, requested/IK-resolved target `joints` and
  final commanded reference `end_joints`, not measured arrival. Planning rates
  default to 1 rad/s and 3 rad/s², or 0.1 m/s and 0.3 m/s² for linear joints,
  capped by known limits.
  The Python planner returns references and duration together. Position devices
  retain the final reference; later writes or stop can interrupt the plan.
  Planning does not promise collision avoidance.
  `track` composes perceive → process → control → world.wait → optional stop → until.
  Each stage references a tool or supplies inline Python: a lambda or source
  defining `main`, called with keyword arguments and returning JSON data.
  Inline calls bypass discovery and use fresh subprocesses with the caller's
  interpreter, working directory, cancellation and deadline. Python tools consume
  an initial `{args,source?}` stdin line before RPC; inline source and arguments
  never travel in argv. Results use the existing JSONL pipes. Only inline control
  has controller capabilities; other inline stages have perception capabilities.
  Process returns a dict directly; optional process/control inputs map JSON
  Pointers from the previous result into arguments. Nulls are misses; absent paths
  are errors. It passes context and predicate state explicitly. `stop_after_control` defaults
  false; misses, errors, cancellation and final exit stop owned motion.
  `track.wait_s` sets the observation/replanning interval; each control call may
  replace the remaining references, and exit or `stop_after_control` may interrupt
  the plan. `settled` checks joint error, quiet velocity and stable world time,
  with an optional world-time timeout. `device` and `devices` share execution; batches
  authorize before dispatch, preserve result order and report per-entry failures.
  Python composition retains capability restrictions and forbids lifecycle changes.
  `run_policy` infers once, converts Cartesian actions using frozen frames and
  seeded IK, and validates device buffers before submitting them concurrently.
  Optional `max_actions` caps the execution horizon before action validation and
  IK, discarding the remainder; each call infers anew. `track` supplies repeated
  observations and world waits for receding horizon control.
  IK failure truncates all buffers to the shared valid prefix, preserving action
  cadence and reporting the failed device, zero-based action index and error.
  IK rejection returns normally, including an empty prefix that leaves existing
  buffers intact. `track` treats controller results as opaque data.
  It returns submission information without waiting or claiming arrival.
  Core prepares `.kinex/python` with uv only when its interpreter is missing.
  Existing environments execute without dependency synchronization; dependency
  changes and repairs are explicit. Concurrent first use within a process waits for preparation,
  including when uv has created the interpreter but has not finished installing.
  Explicit interpreters own their dependencies. Ordinary host shells retain their
  Python environment. Core Python guidance is a single stable paragraph; paths and
  presence are dynamic context, available without onboarding in headless sessions.
- **Recording.** Manual capture is available; model access is opt-in. Native capture
  or dispatch sampling produces manifests, timelines, profile snapshots and
  per-device products; incidental traffic is separate. Acquisition timestamps,
  sample cadence and playback FPS remain distinct. Losses are counted, failures
  are per-device, finalization is bounded and quotas allow limited overshoot. Hosts
  supply transcript references; outcome labels are annotations, not verification.

## Host contracts

Trusted commands and model calls stay separate. Hosts own approval UI, session
identity and cancellation. Standalone retains devices across same-workspace
sessions while ending outgoing recordings; workspace replacement/quit disposes them.
Robotics-containing batches execute in order. Denial/cancellation stops subsequent
scoped calls without rolling back completed work. Tools/skills refresh within tasks.
Stable instructions accompany a dynamic context snapshot restored after compaction.
Images enter history as bytes. Native host contracts belong to the separate plugin
project; core remains host-independent.

## Delivery

This npm workspace releases standalone, core and setup with aligned versions and
exact internal dependencies. Setup imports core package exports; core never imports
setup. Provisioning copies runtime driver support into the workspace so configured
devices continue operating after setup is uninstalled. Node >=22.19; standalone uses
Pi SDK 0.87.1. Native plugins
have independent versions and SDK dependencies in `kinex-plugins`. They import
`@kinex/core` through its package exports, consuming a checked-in tarball snapshot
with checksum and source provenance; no core source is maintained in that project.
Standalone and the native Pi plugin own separate host glue so their SDK upgrades
are independent. Core does not import either host integration.

CI checks core, standalone, real PTY behavior and relocated packages before
producing three tarballs. See [core API](packages/core/README.md),
[setup API](packages/setup/README.md), [usage](README.md) and [progress](PLAN.md).

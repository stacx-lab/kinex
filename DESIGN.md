# Design

Kinex combines one robotics core with standalone and native-host entrypoints.
Hardware and simulators share the same device contracts.

## Structure

| Location | Owns |
| --- | --- |
| `packages/core/src`, `packages/core/assets` | Robotics runtime, business rules and shipped content; no agent/UI dependencies. |
| `src` | Standalone CLI, isolated coding storage and product policy; published Pi SDKs supply the coding harness and TUI. |
| `src/integration` | Standalone Pi integration and product policy, independent of native plugins. |
| `../kinex-plugins` (separate project) | Native Pi, OpenCode and Codex integrations consuming a packed core snapshot. |

`KinexContribution` exposes tools, skills, commands and context. Products explicitly
compose contributions; adapters translate host APIs. Compatible feature changes
flow through these catalogs without per-feature adapter code. New interaction or
lifecycle semantics still require adaptation. Future `real-world` can use this
contract; extraction and a shared default composition module remain deferred.

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
  Persistent drivers use JSONL; one-shot drivers release temporary clients. Core
  includes a mock, not a simulator engine. User commands or permission-checked
  model tools control lifecycle; Python tools cannot. `loaded` is intent, not
  readiness; ordinary calls never restart failed services. Stop bypasses approval.
  Unload attempts capture shutdown, stop and resource release; borrowed services
  are not terminated. Joint goals are absolute, ordered, in radians/metres;
  `write` streams complete `actions` at `freq_hz`, without planning or arrival waits.
  Any positive frequency is accepted; device executors map the chunk onto their
  local clocks. Profiles expose no native period. Results contain
  `completed_actions` (consumed input points, including resampled points),
  actual `elapsed_s` and `state`.
  Upper-layer tools stop, establish measured rest, plan and submit waypoint buffers.
  Optional write `for_s` bounds execution. Trajectory planning uses available joint
  velocity and acceleration limits to cap configurable tool rates.
  Arrival uses wrapped joint errors, measured quiet velocity and a stable device-time
  interval. Timeout, cancellation and faults stop the owned motion. Completed raw
  sequences hold measured state in stepped execution; realtime devices retain their
  last reference.
  A new valid command replaces prior motion on its resource. Cleanup can stop only
  its own motion; explicit user stop remains unconditional. Validation precedes
  replacement. Concurrent writes use independent device lanes; the simulator
  owns their shared world clock. Starts and effects across devices are not atomic.
  Reads never advance the device clock. RPC frequency is independent of servo
  frequency: devices execute buffers locally; tools check arrival at chunk boundaries.
  Uncertain writes are not retried automatically. Generic batch calls are not atomic.
- **Frames and calibration.** Frames form a forest; world is optional and missing
  relationships are not identity transforms. `relative_pose` composes declared,
  live and call-local estimated edges, preferring fewer estimates; samples are
  cached only within a call. `???` is unresolved; `null` follows field semantics.
  Calibration writes are validated and planning is read-only. FK/IK uses declared
  geometry or driver solvers; readiness, world bounds and IK do not certify safe
  or collision-free motion.
- **Tools, skills and Python.** Tools declare schemas, capabilities and timeouts;
  composed calls retain permissions and recording attribution. Skills supply
  procedures. Detection/segmentation feed perception; depth localization respects
  masks and reports camera-relative measurements. Controllers hand devices bounded
  commands. `move_to` pursues a fixed joint or
  pose goal; `drive` holds velocity/posture for a duration. Optional `until`
  predicates split writes at check deadlines. `track` composes `perceive` → `process`
  → `control`; processing maps observations to controller arguments or a miss.
  Controllers own their time bounds; track treats results as opaque and ends on
  its predicate or round/miss limits. Misses and final exit stop owned motion.
  `point_to_pose` converts located points into explicit pose goals. Controller
  faults, stalls and disturbed arrival raise errors after stopping. `run_policy` executes one standalone
  policy chunk using concurrent buffered writes. Cartesian pose and pose-delta
  chunks resolve a frozen frame snapshot and rigid tool offset, then solve IK
  seeded from measured joints and each preceding solution. Deltas accumulate
  translation and left-composed axis-angle rotation in the reference frame.
  The selected chunk is validated before any write; model devices only infer.
  Normal completion follows
  each device’s execution mode; timeout and faults stop the commanded devices.
  `drive` and `track` always stop on final exit. Execution mode belongs to the
  deployment, never to controller arguments. `move_to` generates synchronized
  quintic joint trajectories, submits bounded
  writes and checks arrival at chunk boundaries using 10 Hz holds. Tool defaults
  are 1 rad/s and 3 rad/s² for rotary joints, 0.1 m/s and 0.3 m/s² for linear joints,
  capped by known limits. These are planning policy, not inferred hardware ratings.
  It does not promise collision-free path planning.
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

This npm workspace releases standalone and core with aligned versions and an exact
internal dependency. Node >=22.19; standalone uses Pi SDK 0.87.1. Native plugins
have independent versions and SDK dependencies in `kinex-plugins`. They import
`@kinex/core` through its package exports, consuming a checked-in tarball snapshot
with checksum and source provenance; no core source is maintained in that project.
Standalone and the native Pi plugin own separate host glue so their SDK upgrades
are independent. Core does not import either host integration.

CI checks core, standalone, real PTY behavior and relocated packages before
producing two tarballs. See [core API](packages/core/README.md),
[usage](README.md) and [progress](PLAN.md).

# Design

Kinex combines one robotics core with standalone and native-host entrypoints.
Hardware and simulators share the same device contracts.

## Structure

| Location | Owns |
| --- | --- |
| `packages/core/src`, `packages/core/assets` | Robotics runtime, business rules and shipped content; no agent/UI dependencies. |
| `src` | Standalone CLI, isolated coding storage and product policy; published Pi SDKs supply the coding harness and TUI. |
| `packages/pi` | Shared Pi integration used by standalone, plus the native Pi extension. |
| `packages/opencode` | Server-owned runtime and model tools; TUI command dialogs connect over local Unix IPC. |
| `packages/codex` | Stdio MCP tools, permission/question forms and user controls over private Unix IPC. |

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
  policy chunk using concurrent buffered writes. Normal completion follows
  each device’s execution mode; timeout and faults stop the commanded devices.
  `drive` and `track` always stop on final exit. Execution mode belongs to the
  deployment, never to controller arguments. `move_to` generates synchronized
  quintic joint trajectories, submits bounded
  writes and checks arrival at chunk boundaries using 10 Hz holds. Tool defaults
  are 1 rad/s and 3 rad/s² for rotary joints, 0.1 m/s and 0.3 m/s² for linear joints,
  capped by known limits. These are planning policy, not inferred hardware ratings.
  It does not promise collision-free path planning.
  Core lazily prepares `.kinex/python` with uv; explicit interpreters own their
  dependencies. Ordinary host shells retain their Python environment.
- **Recording.** Manual capture is available; model access is opt-in. Native capture
  or dispatch sampling produces manifests, timelines, profile snapshots and
  per-device products; incidental traffic is separate. Acquisition timestamps,
  sample cadence and playback FPS remain distinct. Losses are counted, failures
  are per-device, finalization is bounded and quotas allow limited overshoot. Hosts
  supply transcript references; outcome labels are annotations, not verification.

## Host contracts

Trusted commands and model calls stay separate. Hosts own approval UI, session
identity and cancellation. Pi keeps devices across same-workspace sessions while
ending outgoing recordings; workspace replacement/quit disposes them. OpenCode
owns one runtime per workspace instance and enforces recording session ownership.

Pi serializes robotics-containing batches; OpenCode serializes Kinex calls only.
Denial/cancellation stops subsequent scoped calls, without rolling back completed
work. Tools/skills refresh within tasks. Stable instructions stay separate from
appended state; compaction restores a full snapshot before continuation. Standalone
adds robotics summary rules; native Pi keeps its summarizer. Images enter history
as bytes. OpenCode's projection ledger stays local to the robotics workspace.

Codex serializes Kinex calls, with immediate stop and invalidation of queued
calls after denial/cancellation. Its MCP process owns one runtime and recording
identity; a separate user CLI shares that runtime without model requests. Stable
instructions accompany discovery; full context is available on demand and changes
are returned with tool results. There is no per-turn/compaction hook or Codex
transcript export. EOF/signals dispose resources. Core remains host-independent.

## Delivery

One npm workspace releases five version-aligned packages with exact internal
dependencies. Node >=22.19; tested hosts are Pi 0.86.1, OpenCode 1.18.31 and Codex 0.155.1.
CI checks contracts, real hosts and relocated packages before producing tarballs.
See [core API](packages/core/README.md), [usage](README.md),
[adapter limits](FEATURE_PARITY.md#11-v060-native-adapter-范围) and [progress](PLAN.md).

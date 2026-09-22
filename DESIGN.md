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
  dispatch validates capabilities, serializes each device and observes traffic.
  Persistent drivers use JSONL; one-shot drivers release temporary clients. Core
  includes a mock, not a simulator engine. User commands or permission-checked
  model tools control lifecycle; Python tools cannot. `loaded` is intent, not
  readiness; ordinary calls never restart failed services. Stop bypasses approval.
  Unload attempts capture shutdown, stop and resource release; borrowed services
  are not terminated. Joint goals are absolute, ordered, in radians/metres;
  a write both sets a goal and executes it for the caller's required positive `for_s`, reporting
  `elapsed_s` in the device's own clock, whether it `reached` the caller's arrival
  spec, and the resulting state. That clock is the only time reference a
  controller reads, so the same call covers the same motion whether a background
  clock advances the world or the write itself does. Nothing about timing is
  declared: no control period, and no command expiry, because the caller's budget
  is the bound. Reads never advance it.
  Uncertain writes are not retried automatically. Batch calls are not atomic.
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
  masks and reports camera-relative measurements. Controllers hand devices bounded goals. `move_to` pursues a fixed joint or
  pose goal; `drive` holds velocity/posture for a duration. Optional `until`
  predicates split writes at check deadlines. `track` alternates point perception
  with `move_to` only, clips each move to its remaining motion budget, stops on
  perception misses and owns the final stop. `run_policy` executes one standalone
  policy chunk and stops the whole group on any device fault. Only an explicit
  `on_timeout: continue` leaves motion active after budget exhaustion; other exits
  stop, and `drive`/`track` always stop on final exit. Execution mode is never
  agent-visible. Controllers provide no general path planning.
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

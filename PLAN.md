# Kinex progress

## Completed: concurrent device I/O

- [x] Separate observation, write, capture and lifecycle scheduling in Kinex;
  correlate persistent driver responses and interrupt affected queued writes.
- [x] Replace RoboEnv world-wide motion waits with deferred per-device segments;
  preserve native owner-thread execution and independent bounded-write results.
- [x] Exercise recording through Kinex → portable drivers → supervisor → CPU worker
  with overlapping writes, including owner-thread physics.
- [x] Preserve stop cancellation through asynchronous driver preparation and active
  one-shot processes; fence failed stops, lifecycle transitions and capture cleanup.
- [x] RoboEnv: 778 tests pass, 41 skip; lint, privacy, SDK/runtime wheels and isolated
  wheel checks pass. Native CPU terminal tests preserve final snapshots and reject
  queued motion. Kinex source integration uses the current checkout.
- [x] Kinex: typecheck, build, 46 standalone tests, 54 core tests and npm packing
  pass. All 13 cross-repository concurrency/lifecycle checks pass against the final
  core build. Persistent custom drivers require the correlated protocol and reload;
  existing RoboEnv services require an owner restart to use the updated runtime.

## Architecture and delivery

- One npm workspace owns `kinex`, `@kinex/core`, `@kinex/pi`,
  `@kinex/opencode` and `@kinex/codex`. All five use version **0.6.0**, exact internal dependencies,
  and a shared CI/release workflow. No separate `kinex_plugins` repository.
- Standalone embeds published Pi SDKs; providers, coding tools, agent loop,
  sessions, compaction and TUI remain upstream-owned.
- Core owns robotics and assets, with no host dependency. Its additive
  `KinexContribution` interface exposes tools, skills, commands and context.
  Products explicitly compose features; adapters convert them to host APIs.
- Future `@kinex/real-world` can contribute beside core using the same adapters.
  Extraction and automatic package discovery are deferred.

## Completed: standalone and host adapters

- [x] Independent standalone with isolated coding storage, preserved robotics
  workspaces, native commands, ask/auto/yolo and recording opt-in.
- [x] Preserve batch-boundary hot loading, prefix-stable context updates,
  sequential robotics batches, denial/cancellation and post-compaction recovery.
- [x] Move reusable Pi ownership, tools, commands, permissions and context code
  into `packages/pi`; standalone imports it without copying an upstream harness.
- [x] Add explicit multi-feature composition with duplicate-name validation,
  refreshed routing, skill loading and namespaced context.
- [x] Native Pi extension: direct commands, conflict aliases, dynamic tools/skills,
  host permissions/UI integration and persistent context projection. Keep native
  Pi's summarizer; refresh a full snapshot before continuation.
- [x] Native Pi lifecycle: same-workspace SDK factory handoff keeps devices and
  ends outgoing recording; workspace changes, reload and quit dispose resources.
- [x] OpenCode server plugin: fixed discovery/call tools, native permissions,
  serial Kinex execution, recording ownership and compaction/context hooks.
- [x] OpenCode TUI plugin: native dialogs and direct commands over private local
  IPC; no model needed. Disconnect cancels work; server owns runtime disposal.
- [x] Preserve ancestor robotics workspace discovery when storing OpenCode context.
- [x] Codex stdio MCP adapter with live contribution discovery, Core permission
  forms/questionnaires, byte images, immediate stop and cancellation of queued work.
- [x] Codex direct user controls share the server runtime over private local IPC;
  manual recording remains available while model recording is opt-in.
- [x] Codex startup/EOF/signals preserve initialization ordering, cancel owned
  processes and finalize recording. Stable instructions and result context keep
  host-independent Core assets authoritative.
- [x] Model context exposes Python paths/readiness without inherited process
  environment variables; execution APIs retain the environment for child processes.
- [x] Five independently packable npm artifacts, release version/dependency guard,
  checksums, CI adapter tests and documentation. Actual publication is not part
  of this stage.

## Completed: bounded controller contracts

- [x] Require positive `for_s` on every actuated write; driver bases and templates
  preserve and validate SDK segment results instead of returning acknowledgments.
- [x] Simplify `drive` to velocity/posture for a duration with optional `until`.
  Remove displacement goals, dead reckoning and continuation from this tool.
- [x] Bound predicate segments by their check deadlines; stop on predicates,
  stalls, faults and arrival. Continuation applies only to budget exhaustion.
- [x] Restrict `track` to point perception plus `move_to`, cap child budgets,
  stop on a miss and every final exit, and retain optional between-round motion.
- [x] Check all policy device faults, restore observation-frame and final quietness
  verification, and return mock snapshots after advancing their clock.
- [x] Simplify the shared runner to fixed commands, validate once per goal/action,
  and keep observation transforms in `move_to`. Remove duplicate final-stop attempts
  and fix policy budget rounding that could start an extra action.
- [x] Final simplification review: 26 focused controller tests pass, including five
  Python driver/cleanup regressions. Diff checks pass. Full builds, broader suites
  and native simulator checks were not rerun, as requested; results below predate
  this simplification pass.
- [x] Typechecking and 44 core tests pass, including driver-wrapper regressions,
  actual runtime schemas, frame conversion and cancellation during perception.
  All 46 standalone and 14 Codex tests pass, including relocated package checks.
  Release metadata and diff checks pass; no packages were published.
- [x] Fresh owned LIBERO services pass `move_to` and `track` in both clock modes.
  `move_to` executes 0.85 device seconds (one realtime write, 17 synchronous
  writes). Tracking reaches in two rounds in both modes, reporting 0.50 and 0.65
  device seconds respectively; perception time is excluded. Both services were
  stopped after validation. Reports: `/tmp/kinex-bounded-fix-native/`.

## Completed: bounded device execution in RoboEnv

- [x] LIBERO, RoboCasa, RoboTwin, BEHAVIOR, RoboDojo, SIMPLE and Isaac Lab share
  world-owned segment scheduling, with deferred realtime completion and atomic
  synchronous control intervals. Device bindings forward budgets, arrival tests
  and final state snapshots.
- [x] Prior fresh `libero/drawer-and-bowl` services passed Kinex `move_to` with a
  15-second device-time budget in both clock modes. The concurrency refactor adds
  CPU coverage; it does not establish task success or fresh GPU replay.

## Control latency follow-up

Earlier LIBERO measurements found roughly 59 ms for a read/write pair and 626 ms
for a perception/control round. Device-owned writes remove the per-step round
trip; perception still has process startup and model inference costs.

- [ ] Evaluate persistent Python perception processes using updated measurements.
- [ ] Measure tracking latency and motion during perception in both clock modes.

## Validation

Validated on Linux, Node 22.19.0, Pi 0.86.1, OpenCode 1.18.31 and Codex 0.155.1:

- Typechecking and builds pass.
- Standalone: **46 tests**, including all four real PTY cases, context/cache
  request capture, P0 batch/compaction behavior, recording and signal cleanup.
- Core: **54 tests**, including concurrent I/O, scoped stop, lifecycle fences,
  response correlation, independent package consumption, contribution
  composition/authorization/cancellation contracts, and the controller engine:
  device-clock budgets, controller stopping and composition, policy chunk replay,
  and guards that keep execution mode out of schemas and tools.
- Native adapters: **14 tests** (7 Pi, 7 OpenCode), including real SDK/plugin
  loading, actual OpenCode model requests and TUI interaction, zero-model device
  commands, hot loading, prefix preservation, compaction, runtime handoff,
  multi-feature routing, IPC cancellation and recording ownership.
- Codex: **14 tests**, including actual host tool-search/model requests and forms,
  hot loading, direct-control PTY confirmation without model requests, shared
  recording, permissions, cancellation, initialization/exit cleanup, bounded
  images and Core+Codex-only package relocation. Core/standalone checks rerun;
  Pi/OpenCode packages and their tests were unchanged in this addition.
- Tarballs install outside the checkout and still run after relocation.
  Standalone installs without OpenCode; adapters install without standalone.
- Local release validation checks workflow syntax, matching/mismatched tags and
  package checksums. GitHub-hosted execution has not run.

Tests use a local HTTP model provider and mock/Python drivers. Controller tests
drive the real tool files over the tool dialog against an in-test device model of
both execution contracts. Separate fresh-service LIBERO smoke tests validate
`move_to` and `track` in both clock modes; see the completed controller work above. No physical hardware
or live provider cache-hit rate was measured. No npm publish, remote push or
release tag was performed for this stage.

## Deliberate first-release limits

- OpenCode direct commands use selection/input dialogs and same-machine Unix IPC;
  remote attach commands and Windows IPC are deferred. Linux is the tested platform.
- Native Pi keeps its own coding permissions and default summarizer. Standalone's
  extra robotics summary rules are application-specific.
- OpenCode serializes Kinex calls; already-running host coding calls cannot be
  rolled back. In-tool questionnaires are declined; use host questions beforehand.
- OpenCode's context ledger is local workspace state and does not accompany host
  session export/fork. An active recording excludes other sessions' non-emergency
  Kinex operations until it ends.
- Codex uses explicit full-context discovery and changed tool-result sections,
  without per-turn/compaction hooks or conversation transcript export. Recording
  belongs to the MCP instance. Direct controls require a running local server;
  multiple instances must be selected explicitly. The queue cannot enforce a
  host-wide turn halt or cancel Codex coding tools. No marketplace wrapper is needed.
- Upstream upgrades require dependency updates and real-host regression checks.
  Standalone third-party Pi package loading remains disabled.

Documentation: DESIGN.md summarizes the current products and core contracts;
AGENTS.md records ownership, invariants and required checks. Detailed behavior and
known gaps remain in package READMEs and FEATURE_PARITY.md.

## Remaining work

- [ ] Extract real-world onboarding into a separate feature package when its
  ownership is concrete; use the existing explicit contribution composition.
- [ ] Broader host/platform compatibility beyond the current local adapters.
- [ ] Exercise `move_to`/`drive`/`run_policy` end to end against a prepared
  RoboEnv workspace in both realtime and `--sync`, including a real frame graph
  for the `locate` transform (the engine tests use same-frame points). Device,
  perception and kinematics latency on that stack is already measured above.
- [ ] Migrate prepared workspaces: `intrinsics.control.execution` has been removed; profiles carrying that field fail
  schema validation, after which its device silently disappears from the model's
  device list. `workspace_libero/.kinex/devices/arm/profile.yaml` was migrated by
  hand; prepared workspaces are regenerated from the catalog, so re-running
  `roboenv prepare` is the general fix.
- [x] Verify bounded `move_to` end to end against fresh RoboEnv LIBERO workers in
  both clock modes; see the bounded-write validation above.
- [ ] Re-measure the 626 ms perception/control iteration against the updated path.
  Start an updated `workspace_libero` service and reload its Kinex devices before
  taking new measurements.
- [ ] Remaining standalone parity priorities: autonomous-mode instructions,
  bounded image attachment handling, loop/task budgets and robotics domain/RoboEnv
  regressions. See [FEATURE_PARITY.md](FEATURE_PARITY.md).
- [ ] Lower-priority command/UI/export/statistics gaps and self-contained Node
  releases. See [CONTEXT_AUDIT.md](CONTEXT_AUDIT.md) for cache validation limits.

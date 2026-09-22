# Kinex progress

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

## Completed: unified control tools

- [x] One controller engine in `kinex/control.py`: `period_s` derives a control
  period from the profile, `advance` re-writes every persistent target and
  follows the device's own clock, and `run` owns the whole termination set
  (`reached | goal_lost | fault | done | until:<tool> | timeout | wall_timeout`).
  `loop()` left `kinex/__init__.py`, which is back to owning only the protocol.
- [x] `move_to`, `drive` and `run_policy` replace `servo_to` and `track`. Goals are
  fixed, pose, re-localized by perception (`refresh_every`: 0 open loop, N closed)
  or policy-supplied; `drive` is the first tool to command a `velocity` device and
  `run_policy` writes a whole embodiment at once.
- [x] Execution mode is no longer agent-visible. Every agent-facing duration and
  rate is stated in the device's own clock, `rate_hz`/`max_steps` are gone from the
  schemas, and `control.period_s` is the only reader of
  `intrinsics.control.execution` outside `velocity.py` and its driver. Tests
  enforce both.
- [x] `intrinsics.control.execution` collapsed to one shape, `{interval_s,
  command_timeout_s}`: no mode is declared anywhere. Which side advances the clock
  is driver-private (`kinex.velocity_driver.Driver.background_clock`), so Core
  needs only the period. The mock honours it by advancing on its own write.
- [x] RoboEnv updated to match (separate repo): every backend now declares the
  control period it actually runs at instead of discarding it — LIBERO/RoboCasa
  0.05, RoboTwin 0.04, BEHAVIOR 1/30, SIMPLE/Isaac Lab 0.02, RoboDojo `???` until
  its live env resolves it. 752 of its CPU-gate tests pass; the one failure
  predates the change.

## The device owns the control loop

The latency measurements below showed a tool-side loop cannot run at the control
rate: it pays a round trip per control period, and one perception per iteration
came to 626 ms against a 50 ms budget. So the loop moved into the device.

A write now both sets a goal and executes it, returning `elapsed_s` (the
simulated time that call was worth), `reached`, and the resulting state. The
caller's loop is identical in both modes and differs only in how many times it
goes round: one call where a background clock runs the motion, one control
interval per call where the write is what advances physics. Because the write
returns the state, **a round costs exactly one round trip and the loop never
reads** — a test asserts the read count is one, the final verification.

`kinex/control.py` lost its whole timing apparatus: `period_s`, `DEFAULT_PERIOD_S`,
`SLACK`, `STALL_PERIODS`, the per-iteration read and the clock-following wait.
Nothing sleeps and nothing polls.

Tools: `move_to` and `drive` are open-loop segments — one goal, one budget,
`on_timeout: stop|continue` choosing whether motion carries on while the caller
thinks. `track` closes the loop by alternating any perception tool with any
controller, passing the result as `observation`; segment length alone spans open
loop, closed loop and policy rollout. `run_policy` executes one inference worth
of actions and is a `track` controller; `observe` gathers the bundle it needs.

Two device-side guards were needed and are worth recording: a settle wait is
bounded in wall time as well as in frames, so a stalled background clock cannot
hang a caller; and a write with no `for_s` does not wait at all, which keeps
fire-and-forget behaviour for callers that have not opted in.

`intrinsics.control.execution` is gone entirely — no control period, no command
expiry. Once a write runs the goal for the caller's `for_s` and reports the time
it spent, the caller's budget *is* the bound, so there was nothing left to
declare. Isaac Lab derives its period from the native physics config
(`cfg.sim.dt * cfg.decimation`, which it previously only cross-checked the
catalog against), the in-memory mock keeps a synthetic clock of its own, and the
velocity driver's `threading.Timer` watchdog went with the field. Timing is now
entirely the driver's business, which is where it always belonged.

## Control-loop latency: the measurements that forced this

`control.period_s` is a **ceiling, not a guarantee**. `advance` sleeps
`period - moved`; when an iteration has already overrun it sleeps zero and the
loop simply runs slower. Nothing errors and nothing catches up. What that costs
depends entirely on which side advances the clock.

Measured on `workspace_libero` (LIBERO `drawer-and-bowl` on a live RoboEnv
worker, Grounding DINO tiny on an H100, warm; p50 of 6-20 calls):

| step | p50 | note |
| --- | --- | --- |
| `arm` read | 22 ms | one HTTP round trip to the worker |
| `arm` write | 37 ms | |
| `arm` ik | 35 ms | numerical DLS, over the same transport |
| `camera` read | 38 ms | RGB capture + PNG |
| `grounding-dino` detect | 161 ms | H100, weights resident |
| `relative_pose` tool | 219 ms | |
| `locate_object_3d` tool | 313 ms | camera + detect + 3D |

LIBERO declares `interval_s: 0.05`, so the loop's target period is 50 ms (20 Hz).

- **read + write only: 59 ms -> 16.8 Hz.** A fixed-goal `move_to` roughly keeps
  up, with no headroom.
- **one perception per iteration: 626 ms -> 1.6 Hz**, against a 20 Hz target.
  Twelve times too slow.

### Where the time actually goes

Not mostly in the network. A Python tool is spawned per call
(`python-runner.ts` `spawnProcess`), and in the Core interpreter that costs
30 ms bare, 60 ms with `kinex.frames`, and **170 ms with `kinex.object_location`**
(numpy + PIL). So `locate_object_3d` spends more time starting a process and
importing than Grounding DINO spends on the forward pass. Roughly 54% of every
perception call is fixed overhead, re-paid on every closed-loop iteration.

### Consequence per mode

Measured separately against the in-test device model, injecting perception
latency into `move_to`:

| perception/step | sync device time | sync iters | realtime device time | realtime iters |
| --- | --- | --- | --- | --- |
| none | 0.600 s | 30 | 0.606 s | 29 |
| 50 ms | 0.600 s | 30 | 0.644 s | 12 |
| 300 ms | 0.600 s | 30 | 0.911 s | 3 |

**In sync, latency is free in the only currency that matters.** Writes are the
only thing that ticks physics, so the world is frozen while the tool thinks; the
simulated result is invariant to how slow perception is, and only wall time
grows. **In realtime it converts directly into stale feedback**: a 50 Hz loop
became three corrections, and the motion took 50% longer in *device* time
because it overshot.

Only velocity devices can actually break. `joint_driver.py` arms no watchdog, so
`move_to` degrades smoothly. `velocity_driver.py` does: with
`command_timeout_s: 0.5` and 800 ms between writes, the driver halted the base
three times and it stop-started to the goal — while the tool still reported
`reached: true`.

### What follows

- **Closed-loop visual servoing belongs in sync mode.** On this stack realtime
  plus per-iteration perception is not viable, and no tuning inside the loop
  changes that.
- On a realtime backend, `locate.refresh_every` must be raised well above its
  default of `1` so cheap rewrites carry the loop between occasional fixes. The
  default is right for a cheap predicate and wrong for a detector.
- `run_policy` has the same shape: at `action_hz: 10` there is 100 ms per action,
  which VLA inference typically exceeds. Free in sync, degrading in realtime.

### Open work this creates

- [ ] Report the degradation instead of hiding it. `advance` knows the achieved
  inter-write interval; when it exceeds `command_timeout_s` the outcome should
  carry a `refresh_overruns` count rather than a bare `reached: true`.
- [ ] Persistent Python tool processes. Removing per-call spawn and numpy/PIL
  import would roughly halve perception latency, and it is the single largest
  lever measured — larger than the detector itself.
- [ ] Batch the per-iteration device traffic. `move_to` currently pays a separate
  round trip for read, write and `advance`'s confirming read; `kinex.devices()`
  already exists for concurrent dispatch.
- [ ] Decide whether realtime closed-loop perception is a goal at all. If it is,
  it needs the three items above plus a way to keep commanding while a fix is in
  flight; if it is not, say so in the tool descriptions.

## Validation

Validated on Linux, Node 22.19.0, Pi 0.86.1, OpenCode 1.18.31 and Codex 0.155.1:

- Typechecking and builds pass.
- Standalone: **46 tests**, including all four real PTY cases, context/cache
  request capture, P0 batch/compaction behavior, recording and signal cleanup.
- Core: **26 tests**, including independent package consumption, contribution
  composition/authorization/cancellation contracts, and the controller engine:
  control-period derivation, mode equivalence for identical arguments,
  open-vs-closed loop, detector loss, stop-on-raise, policy chunk replay rate and
  two guards that keep the execution mode out of schemas and tools.
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
both execution contracts; they do not run a simulator. No physical hardware
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
- [ ] Migrate prepared workspaces: `intrinsics.control.execution` is now just
  `{ command_timeout_s }`, and a profile carrying `mode:` or `interval_s:` fails
  schema validation, after which its device silently disappears from the model's
  device list. `workspace_libero/.kinex/devices/arm/profile.yaml` was migrated by
  hand; prepared workspaces are regenerated from the catalog, so re-running
  `roboenv prepare` is the general fix.
- [ ] Verify end to end against a live RoboEnv worker. The changes are in place
  on both sides but the running `workspace_libero` sim predates them, and its
  runtime is an editable install, so it needs a restart to pick them up. Re-measure
  the 626 ms closed-loop iteration against the new path when it is restarted.
- [ ] Remaining standalone parity priorities: autonomous-mode instructions,
  bounded image attachment handling, loop/task budgets and robotics domain/RoboEnv
  regressions. See [FEATURE_PARITY.md](FEATURE_PARITY.md).
- [ ] Lower-priority command/UI/export/statistics gaps and self-contained Node
  releases. See [CONTEXT_AUDIT.md](CONTEXT_AUDIT.md) for cache validation limits.

# Design

Kinex combines an operational robotics core and optional setup features with
standalone and native-host entrypoints.
Hardware and simulators share the same device contracts.

## Structure

| Location | Owns |
| --- | --- |
| `packages/core/src`, `packages/core/assets` | Device registration/removal, provisioning, runtime, schemas, validation, Python/tools, setup-device and complete device guides; no setup/agent/UI dependencies. |
| `packages/setup` | Onboarding and calibration tools, procedures and assets; depends on core. |
| `src` | Standalone CLI, isolated coding storage and product policy; published Pi SDKs supply the coding harness and TUI. |
| `src/integration` | Standalone Pi integration and product policy, independent of native plugins. |
| `../kinex-plugins` (separate project) | Native Pi, OpenCode and Codex integrations consuming a packed core snapshot. |

`KinexContribution` exposes tools, skills, commands and context. Products explicitly
compose contributions; adapters translate host APIs. Compatible feature changes
flow through these catalogs without per-feature adapter code. New interaction or
lifecycle semantics still require adaptation. Standalone composes core and setup by
default. Core-only consumers retain all
utilities needed to provision, register, remove and operate devices, including lifecycle, transforms,
kinematics, perception, control, recording and lazy Python preparation. Setup borrows
the runtime through tracked operations/tool execution; the runtime owns cancellation,
recording attribution and disposal. Unregister lives in core and holds its device
transition fence through deactivation and deletion.
Unregister also removes unloaded devices without starting their drivers.

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
  interrupts affected driver calls and clears their queued writes; physical
  interruption follows the device's declared operation-specific stop scope. Lifecycle
  transitions fence resource users before releasing connections.
  Persistent drivers use JSONL; one-shot drivers read one `{action,args}` stdin
  line and release temporary clients. Core
  includes a mock, not a simulator engine. User commands or permission-checked
  model tools control lifecycle; Python tools cannot. `loaded` is intent, not
  readiness; ordinary calls never restart failed services. Stop bypasses approval.
  Unload attempts capture shutdown, stop and resource release; borrowed services
  are not terminated. Joint goals are absolute vectors in model order, in radians/metres.
  Home is a plain joint-name-to-position map. Joint devices returning to declared
  home may use a fixed 1° revolute recovery margin: the out-of-limit prefix moves
  inward and the final target stays within limits. Measured starts are not clamped;
  prismatic limits remain strict. The margin is not configurable in profiles.
  All actuator writes submit a validated buffer with `duration_s` and return
  immediately with `execution_id` and measured `state`.
  Gripper and suction actions are flat numeric sequences; joint and dexterous-hand
  actions are sequences of joint vectors. One command is a one-element sequence.
  New writes replace pending references without stopping; invalid writes leave
  them intact. Devices consume buffers at their fixed cadence. Position commands
  retain their final reference; velocity commands expire to zero velocity while
  preserving posture. Explicit stop clears affected buffers. Background faults
  remain visible through reads. Ownership outlives write calls; cleanup cannot
  stop a replacement owned by another invocation.
  Failed post-submission feedback validation cancels only that submission before
  reporting failure. Failed cleanup reports `stop_failed` and blocks further
  writes until recovery.
  `world.read` returns `time_s` and optional `budget: {used_s, max_s}`. Budget
  values are episode time in seconds: finite nonnegative elapsed time and a finite
  positive allowance, or `max_s: null` for no cap. Drivers own accounting and
  conversion to seconds; Kinex neither infers a budget nor enforces its allowance.
  `world.wait(duration_s)` returns only `time_s` and actual `waited_s` for that
  wait. The TUI displays world time fields to at most six decimal places; tool
  results retain full precision. Drivers abstract physical and simulated clocks. Concurrent
  waits share world time and support individual cancellation. Reads never advance
  time. Persistent world waits retain the per-call wall-clock deadline (60 seconds
  by default, overridden by `access.driver.timeout_s`). Timeout cancels only that
  wait, allowing one additional configured timeout interval for its response and
  interrupt acknowledgement.
  Successful recovery preserves the driver and reports `wait_timeout` without elapsed
  time; failed recovery terminates the driver and requires an explicit load.
  Caller cancellation shares the same bounded recovery. Cancellation does not reset
  the world or clear actuator buffers: RoboEnv realtime continues, while stepped
  execution pauses when no waits remain. Uncertain writes are never retried automatically.
  Device observations use one finite numeric `timestamp` in seconds, including
  measured state in write results. Use acquisition time, or receipt time when it is
  unavailable, in the device's clock. Combined observations use the latest component
  time; cached observations retain it. RoboEnv timestamps use simulation time.
  Camera reads accept output=file (default), array or base64. File output returns
  file/depth_file; Python array output returns owned uint8 RGB color and uint16
  depth arrays; base64 returns PNG/PGM16 strings under color/depth. One timestamp
  covers both streams. Arrays cross JSON boundaries as base64, decoded in the
  calling Python runtime. Server-to-driver transport is unchanged. Fixed dimensions
  stay in profiles and are validated against image contents. Agent-facing device tools
  allow only file output and return paths in JSON
  without attaching image bytes; the host file-reading tool handles explicit
  image inspection. Standalone uses Pi's native `read` tool.
  Generated UUIDs are replaced by 16 random hexadecimal characters; IDs remain opaque.
- **Frames and calibration.** Local frames declare `parent_frame`, `translation_m`
  and `rotation_xyzw`; null parent means device base, null components mean unknown.
  Joint `kinematics.frame` and hand geometry declare computed frames relative to
  the device base; do not duplicate them in `frames`. Additional explicit frames
  may name computed parents. Joint reads and write-result states omit `frame_poses`; live joint frames use FK
  from measured positions without clamping. FK/IK accept device-local `frame` and
  `reference_frame` and include both in results. Defaults are the modeled endpoint
  and null (device base); targets may be fixed endpoint descendants and references
  may be fixed base frames. Gripper frames are fixed references; other spatial
  devices may supply parent-relative live frame feedback for unknown transforms.
  Velocity reads and write states omit global `pose`; feedback has no `pose_frame`.
  Bases are unlocalized roots without fixed mounts. Body height and nonempty local
  `frame_poses` may be measured feedback; explicit frame queries compose them and
  call-local estimates can connect a base to world. Native command bounds describe
  controller input ranges; `limit_handling: native` preserves native saturation.
  Frames form a forest; world is optional and missing
  relationships are not identity transforms. `relative_pose` composes full local
  poses attached to its child and parent frames, using declared,
  live and call-local estimated edges, preferring fewer estimates; samples are
  cached only within a call. Its tool result contains only `pose`, `path` and
  `estimated_links`; input and returned poses use `[x,y,z,qx,qy,qz,qw]` in metres
  with a unit xyzw quaternion. The Python `frames.pose()` API retains separate
  translation and rotation fields. `???` is unresolved; `null` follows field semantics.
  Calibration writes are validated; plan inspection is read-only. Setup owns a persisted,
  agent-authored DAG with task-selected prerequisites and evidence-backed outcomes.
  Completed plan nodes check fact availability, explicit values and completed
  prerequisites, without comparing receipt hashes after content or definition edits.
  Calibration attempts and solver results retain their own fingerprint checks.
  Calibration settling requires fresh declared velocity feedback (including hands);
  it never advances simulator time. A settle timeout after a read saves that sample
  as `settled:false`; FK and archival retain caller cancellation independently of
  the settle deadline. RGBD samples archive both color and depth before appending.
  Unrelated or incomplete calibration never becomes a global execution gate.
  Profile completeness is descriptive; each operation retains its own validation. FK/IK uses declared
  geometry or driver solvers; readiness, world bounds and IK do not certify safe
  or collision-free motion.
  Numerical DLS IK tries the original seed first, then deterministic nearby and
  broader seeds. Optional `ik.search` defaults to five total attempts, 0.02 seconds
  per attempt and 0.1 seconds total per target; `max_iterations` also bounds each
  attempt. Cancellation and monotonic deadlines are checked between iterations.
  Deadlines are cooperative; the current iteration or final verification may overrun.
  Search selects the verified candidate nearest the original seed using
  joint-range-normalized displacement; only zero displacement ends search early.
  Numerical and native IK normalize rotary solutions to the nearest equivalent
  angles within joint limits before independent FK verification. Prismatic
  coordinates are unchanged. This preference is not a hard waypoint-step limit.
  Pose tolerances remain unchanged.
  Exhaustion reports attempts, iterations, elapsed time and best observed residuals;
  it does not establish unreachability. Native driver IK retains its own solver.
  Shared Python pose validation and call-local frame estimates normalize xyzw
  quaternions only when their norm is within `[0.999, 1.001]`, inclusive.
  Persisted-profile schemas and velocity-reading validation remain strict.
- Gripper stop clears pending references while retaining the last applied grip target
  and its actuator preload. Direction grippers stop integration at the accumulated
  target; position grippers retain their applied position reference. Never replace
  a loaded grip target with measured aperture. Explicit open releases a grasp.
  Reset seeds a fresh hold from measured posture; stop before first write must not close.
- Gripper reads expose physical aperture, faults and timestamp.
  Reads and write states omit finger poses. Finger measurements and aperture conversion remain private
  to the driver. The mount locates the gripper base; `intrinsics.frames.tcp` locates
  the tool point. Gripper geometry retains axes and an optional finger description,
  with no contact-frame entries. Gripper and hand physical descriptions may live
  in `geometry.description`; other device profile prose remains in guides.
  Dispatch validates actuator write states with the same checks as reads and
  stops the device if a write returns invalid state or faults.
- Dexterous hands retain joint-vector control and optional fingertip geometry.
  Finger chains name model joints directly in traversal order, starting at the
  device base; no separate finger joint list or palm/reference selectors are used.
  Fixed palm and grasp references are ordinary local frames. Geometry may contain
  only a physical description; FK requires fingers or declared endpoint kinematics.
  An optional weighted center is a geometric reference with fixed orientation,
  not contact feedback. Tip offsets remain explicit; joint metadata stays in model.
- World provides time and waiting. Device feedback retains timestamps without a
  clock-type label; removing labels does not convert or synchronize timestamps.
- **Tools, skills and Python.** Tools declare schemas, capabilities and timeouts;
  composed calls retain permissions and recording attribution. Skills supply
  procedures. Shared device context and setup guidance cover cross-type contracts;
  each device guide owns its Setup details and a concise, model-visible Use section.
  Agent authoring of custom `devices/<name>/DEVICE.md` is allowed only for type
  `legged_base`; other types use shared guides, profile parameters and driver SDK
  adaptation. Runtime context rejects custom per-device guides for types outside
  this allowlist. Allowed guides take precedence over shared type guides with
  normal content precedence. Guidance
  is scoped to its devices and refreshed in dynamic context; Setup stays excluded.
  `legged_base` prefers shared velocity parameters and semantics for equivalent
  motion and readback, with driver-side SDK adaptation. Custom instance guide
  authoring is reserved for `legged_base`. Its control declares a write argument schema,
  a minimal skill catalog and optional `device_modes` graph. The driver
  validates live prerequisites, submits SDK operations without waiting for physical
  completion, and owns cancellation/replacement. `mode` is the single
  state/mode selector for writes and measured readback. Motion uses named-axis velocity,
  optional posture and duration_s with velocity expiry to zero. State changes and
  optional skills extend that interface without artificial motion fields.
  Legged stand/crouch transitions need not support reliable interruption;
  document their stop limits rather than disabling them for that reason.
  Detection/segmentation feed perception; depth localization respects
  masks and reports camera-relative measurements. `servo` accepts joint and
  dexterous-hand devices. Joint targets need no geometry; pose targets require
  declared endpoint IK, which fingertip geometry alone does not provide. It plans
  from measured joint positions and submits a full trajectory at its computed
  duration, without waiting, stopping, settling or arrival checks. It accepts no duration override;
  results report `device`, the driver's `execution_id`, requested/IK-resolved
  target `joints`, computed `duration_s` and `actions_submitted`, not measured
  arrival. Driver feedback remains validated before returning. Planning rates
  default to 1 rad/s and 3 rad/s², or 0.1 m/s and 0.3 m/s² for linear joints,
  capped by known limits.
  Servo reads measured positions once before IK and planning, projecting only the
  IK seed into model bounds when needed. `max_joint_delta` bounds travel from that
  measurement for both joint and pose goals, before submission, only when supplied.
  It accepts a positive scalar or a positive per-joint vector in radians or metres;
  omission imposes no travel cap. This is a caller-selected planning constraint,
  not a hardware rating. Continuous travel takes the shortest angle; explicit
  bounded joint targets are not wrapped. Rejection names offending joints with measured/requested
  positions, deltas and allowed deltas, without replacing existing motion.
  The Python planner returns references and duration together. Position devices
  retain the final reference; later writes or stop can interrupt the plan.
  Planning does not promise collision avoidance.
  `closed_loop` composes perceive → process → control → world.wait → optional stop → until.
  It addresses the gap between commanded and measured outcomes through feedback
  and repeated control. Its guidance owns composition recipes; individual
  controllers and model devices describe their own contracts independently.
  It supplies repeated observations and world waits for receding horizon control
  and treats controller results, including normal IK rejection, as opaque data.
  Only world and wait_s are required. Omitted or null stages return an empty dict
  without execution; a disabled process does not forward observation. Predicate
  results must be dicts; missing done means false, and supplied done must be boolean.
  Without a stopping predicate, round limits and the outer timeout still apply.
  Each configured stage references a tool or supplies inline Python: a lambda or source
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
  `closed_loop.wait_s` sets the observation/replanning interval; each control call may
  replace the remaining references, and exit or `stop_after_control` may interrupt
  the plan. `settled` checks joint error, quiet velocity and stable world time,
  using strictly advancing device timestamps as fresh evidence and an optional
  world-time timeout. Changing targets resets stability but retains the timeout;
  predicate state retains `sample_timestamp` separately from world time.
  When joint velocity feedback is unavailable, `settled` estimates velocity from
  up to three fresh position samples using device time and continuous-joint wrapping.
  Three samples are required for completion; calibration sampling still requires
  declared measured velocity feedback.
  `device` and `devices` share execution; batches
  authorize before dispatch, preserve result order and report per-entry failures.
  Public failure `code` and `details` survive direct tools, batches and Python
  composition without driver stderr. Python raises `RPCError`, a `RuntimeError`
  subclass; uncaught structured failures cross JSONL with their metadata.
  Python composition retains capability restrictions and forbids lifecycle changes.
  `run_policy` infers once, converts Cartesian actions using frozen frames and
  seeded IK, and validates device buffers before submitting them concurrently.
  Its initial seed projects measured positions to joint limits while FK retains
  the measured configuration; subsequent solves use the preceding solution.
  Optional `max_actions` caps the execution horizon before action validation and
  IK, discarding the remainder; each call infers anew.
  IK failure truncates all buffers to the shared valid prefix, preserving action
  cadence and reporting the failed device, zero-based action index and error.
  IK rejection returns normally, including an empty prefix that leaves existing
  buffers intact.
  `stop_failed` remains a failure, never a normal IK truncation.
  It returns `actions_submitted`, `duration_s`, `execution_ids` (device to driver
  execution ID) and `ik_failure`, without waiting or claiming arrival. An empty
  prefix returns an empty execution map. Runtime checks use selected devices;
  these builtins do not impose redundant global capability requirements.
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

Trusted commands and model calls stay separate. Standalone credentials remain
in Kinex data storage. A managed agent-directory auth link
gives the host and SDK-default extension child sessions the same credential and
lock path, including OAuth refreshes. Conflicting auth entries are never overwritten.
Hosts own approval UI, session
identity and cancellation. Standalone retains devices across same-workspace
sessions while ending outgoing recordings; workspace replacement/quit disposes them.
Robotics-containing batches execute in order. Denial/cancellation stops subsequent
scoped calls without rolling back completed work. Tools/skills refresh within tasks.
Stable instructions accompany a dynamic context snapshot restored after compaction.
Images enter history as bytes. Native host contracts belong to the separate plugin
project; core remains host-independent.
Robot context omits workspace safety limits and keep-out zones. Those fields remain
in the manifest; `safety.notes` is no longer part of its schema.

Setup bundles pinned upstream `pi-web-search` and `pi-btw` packages and exposes
their locations through `@kinex/setup/extensions`. Standalone loads them through
Pi's resource loader. Explicit npm package settings take precedence at
startup. Core remains independent of these extensions; BTW child sessions use
upstream coding tools and shared credentials, without Kinex's robotics runtime
or permission hooks.

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

CI checks core, setup, standalone, real PTY behavior and relocated packages before
producing three tarballs. See [core API](packages/core/README.md),
[setup API](packages/setup/README.md), [usage](README.md) and [progress](PLAN.md).

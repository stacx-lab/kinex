# @kinex/setup

Host-independent, task-scoped embodiment onboarding and calibration. Requires
Node >=22.19 and an aligned `@kinex/core` version.

Setup maintains an agent-authored dependency graph, selects the current task's
prerequisites, and archives evidence. Unrelated calibration stays deferred.
Neither an unfinished plan nor overall profile completeness gates device use;
core still validates each operation and the host still owns permissions.

## Composition

```ts
import { createKinexRuntime } from "@kinex/core"
import { coreContribution, composeContributions } from "@kinex/core/integration"
import { createKinexSetup, setupContribution, setupSkillRoots, setupToolNames } from "@kinex/setup"

const runtime = createKinexRuntime({
  directory: process.cwd(),
  builtinSkillRoots: setupSkillRoots,
  reservedToolNames: setupToolNames,
  host: { ask: async request => { /* authorize or throw */ } },
})
const setup = createKinexSetup(runtime)
const capabilities = composeContributions([coreContribution(runtime), setupContribution(setup)])
try {
  const tools = await capabilities.tools.list()
  const skills = await capabilities.skills.list()
  const plan = await setup.plan.inspect()
  // Register tools, skills and capabilities.commands with your host.
} finally {
  await runtime.dispose()
}
```

Standalone enables this composition. Discovery retains nearest-project, ancestor,
global and packaged precedence. Setup borrows core's tracked runtime, cancellation,
recording attribution, Python and owned-process lifecycle. Construction and plan
inspection do not create a workspace or initialize Python.

Standalone's `ApplicationOptions.composition` selects roots, reserved names and a
`contributions(runtime)` factory together, before runtime construction.
For core alone use `{ contributions: runtime => [coreContribution(runtime)] }`.
Custom setup composition explicitly supplies `setupSkillRoots`, `setupToolNames`
and its setup contribution. Omitted values do not inherit standalone's defaults.

The `onboard-ros2` skill owns ROS policy and the `kinex_ros` library.
ROS support targets Jazzy on Ubuntu 24.04 with system Python 3.12; older ROS
distributions and Python 3.10 are unsupported. Setup context
provides separate absolute `core_library` and `setup_library` roots for provisioning.
A completed generation contains its own ROS helpers; its profile pins entry and
interpreter paths. Removing setup leaves that driver operational through core.
See [bundle contracts](assets/builtin/skill/onboard-ros2/references/bundles.md) and
[legacy migration](assets/builtin/skill/onboard-ros2/references/migration.md).

Setup also bundles `pi-web-search` 1.7.0 and `pi-btw` 0.7.1 as npm dependencies.
`setupPiExtensions()` from `@kinex/setup/extensions` returns their package names
and absolute package directories for a Pi host's resource loader. Standalone
loads these extensions by default; other hosts opt in through this export.
Importing setup does not activate a Pi session or load these extensions.
Web search uses the host's model and credentials. BTW creates upstream Pi side
sessions; those sessions do not inherit Kinex robotics tools or permission hooks.

## Tools and workflows

| Tool | Responsibility |
| --- | --- |
| `setup_plan` | Read/save a DAG, select a task's targets, and record evidence-backed outcomes. |
| `calib_sample` | Capture one measured sample into an isolated, participant-bound attempt. |
| `calib_compute` | Run bundled offline solvers or model introspection and propose exact profile changes. |

`calib_sample.settle` supports joint devices, dexterous hands and velocity devices
with declared measured velocities. Only distinct device timestamps count toward
stability. A timeout after a reading saves `settled: false`, including requested
FK; caller cancellation saves no sample. The sampler does not advance simulator
time, so arrange world waits outside it. RGBD evidence copies both color and depth
into attempt artifacts before appending the sample.

`/onboarding [objective]` prepares the embodiment and follows only the requested
objective's prerequisite subgraph. Without a task it prepares profiles/drivers and
reports possible next steps, leaving measurements deferred. `/calibrate [scope]`
resumes selected measurement work; it never exhausts an unrelated backlog.

For ROS devices, `/onboarding [objective]` and `/register` select `onboard-ros2`
through their existing workflows. No dedicated ROS command or alias is needed.

Core owns `profile_write`, `setup-device`, registration, generic provisioning and driver operation,
load/unload, read/write, motion and stop. Prepare profiles/drivers incrementally
before measurement. Apply accepted results through `profile_write`; clear requests
explicitly only when their whole section is resolved. Translation-only TCP evidence
may satisfy a task while its orientation request remains open.

Hosts can pass `setupPermissionDefaults` to `kinexPermissionAction`: local plan
mutations default to `setup_plan: allow`, offline computations to
`calib_compute: ask`. Explicit rules take precedence. Samples retain `device_read`;
physical operations use existing core permissions. Public package APIs are trusted
host operations; model calls must use the permission-checked tool contribution.

## Plan and evidence contracts

`.kinex/setup/plan.json` stores version 1 nodes, the current task, a revision and
outcome receipts. Agent-authored nodes declare `id`, `title`, `kind`
(`prepare`, `calibrate`, `verify`), `skill`, role-to-device `bindings`, `dependsOn`,
`inputs`, `outputs`, and an optional `optional` flag. Profiles remain the source of
truth for actual devices; future preparation nodes can name not-yet-created devices.
The physical frame graph and procedural dependency DAG are different.

Facts use `{kind:"profile", device?, pointer, value?}` or `{kind:"file", path}`.
Omit device to read the workspace manifest. JSON pointers select narrow facts;
value optionally requires exact equality. Null retains its profile meaning; `???`
and absent fields are unknown. File paths are relative to `.kinex` or absolute.
Use narrow profile pointers for both inputs and outputs, tracking only facts relevant
to the node's conclusion. Keep volatile loaded/meta fields and live poses out of
persistent calibration dependencies and outputs. World motion does not invalidate
arm-to-base geometry.
Record required driver/model files as inputs. Plan inspection checks their presence;
calibration attempts separately fingerprint input contents, including URDF bytes.
Planning never resolves models or reads hardware.

A task has `objective`, `targets` (node IDs), and optional direct `facts`. Only the
targets and their transitive prerequisites are required now. Empty targets can
express a task requiring no calibration. `task:null` defers all measurement work.
The default view collapses deferred and completed work; `full:true` includes nodes
and procedure descriptors. `taskSatisfied` concerns declared requirements, not a
certification that the robot can safely accomplish the task.

Save/select/record require the returned revision. Invalid references, cycles,
participant mismatches and missing producer dependencies are rejected. Outcomes
are `done`, `partial`, `failed` or `needs-input`; observation also derives `ready`,
`blocked` and `stale`. Completion requires existing evidence and expected outputs.
Completed nodes become stale when required facts, outputs, evidence files or completed
prerequisites are missing, including when an explicit profile value no longer matches.
Content changes, node-definition edits and re-recorded completed prerequisites alone
do not invalidate receipts. Reassess their relevance when modifying a completed plan.
Receipts contain status, note, evidence and time; old hash fields are ignored on read
and removed on the next plan write. Calibration attempts and solver results retain
their separate input, definition and prerequisite checks. Malformed deferred
procedures are reported without gating unrelated tasks.

For example, establish an existing camera connection without calibrating geometry:

```json
{
  "action": "save",
  "revision": 0,
  "plan": {
    "version": 1,
    "nodes": [{
      "id": "camera-access", "title": "Prepare camera access", "kind": "prepare",
      "skill": "setup-device", "bindings": {"device": "camera"},
      "outputs": [{"kind": "profile", "device": "camera", "pointer": "/access/driver"}]
    }],
    "task": {"objective": "View camera images", "targets": ["camera-access"]}
  }
}
```

Archive the connection/static/live verification evidence, then record the outcome.
This example checks declared output presence; the agent must choose and substantiate
checks appropriate to the actual interface, rather than treating file existence as
proof of live connectivity.

Attempts live in `.kinex/calib/<run-id>/` with a manifest, `samples.json`, immutable
artifacts, numbered solver results and a latest `result.json`. Start sampling or
computing with `node`, or with `procedure` plus bindings and inputs. Reuse the
returned `run` thereafter. Participants/procedure/inputs cannot change within an
attempt. Camera images and solver source files are copied before use. Old samples
are preserved; record exclusions in a separate solver input with references to them.
Results separate computation, quality, resolved fields, unresolved facts and
`proposedChanges`. Failed quality proposes no writes. Warnings require review against
task accuracy. If the user explicitly requests keeping an over-limit result during
setup, honor that request without refusing or forcing recollection due to the error.
When requested, apply computed fields from archived solver data with `profile_write`
even when `proposedChanges` is empty, preserving frame conventions and validation.
Archive the errors, limits and user decision; retain the original quality assessment
and do not mark a failed-quality node done. Record the returned numbered `evidence` path after applying and
verifying accepted changes; later solves do not overwrite that evidence.

`setup.plan` exposes `inspect`, `read`, `save`, `select`, and `record`.
`setup.calibration.compute` exposes the offline computation API.

## Procedures and embodiments

Measurement skills have a `procedure.json` declaring concrete roles, applicable
types, distinct participants, parent relationships, required profile pointers,
produced fields, supported computations and quality criteria. Setup reads the
sidecar from the skill directory selected by core discovery. Custom skills without
sidecars remain usable with explicitly authored requirements/evidence. The compute
tool executes only known bundled programs; overriding prose does not replace its
Python executable. Custom computations use host tools and archive their evidence.

| Skills | Coverage |
| --- | --- |
| `onboard-ros2` | ROS integration selection, provisioning, registration and interface verification; explicit plan requirements without a fixed procedure. |
| `calibrate-camera-intrinsics`, `calibrate-camera-extrinsics` | Color image geometry and camera mounting. |
| `calibrate-tcp-offset` | Tool-tip translation; orientation is separate. |
| `calibrate-fixed-arm-mount`, `calibrate-dual-arm` | Rigid parent/arm or cross-arm transforms. |
| `calibrate-joint-range`, `calibrate-world-geometry` | Joint/model limits and independently measured environment geometry. |
| `verify-base-interface`, `verify-base-motion`, `verify-base-posture` | Selected base conventions, motion response, expiry/stop and posture references, evaluated with `verify-base`. |

Fixed arms, dual arms, wheeled manipulators, quadrupeds with arms and humanoids use
actual endpoint/frame compositions. Moving torso attachments and body/heading
frames remain explicit. Base procedures are selected as needed; they do not require
all axes to be calibrated before any base operation. Normalized commands retain
their units. No gait tuning, odometry optimization or inferred motion limits.

Collect incrementally, reuse suitable factory/model/simulator facts and stop when
minimum evidence, coverage and quality meet the task. Explicit tolerances are
required for verification measurements; missing references remain incomplete.
ROS onboarding assesses `check.sh` results directly and retains its measurement
file as evidence on the preparation node when setup planning is used. Failed
checks leave onboarding incomplete. Existing base procedures use `verify-base`
with the evidence format documented in the `calib_compute` tool description.

## Migration and checks

Replace `calib_plan` with `setup_plan` (`action:read`), and
`setup.calibration.plan()` with `setup.plan.inspect()`. Replace `device_calibrate`
with `calib_compute` (`operation:urdf-introspect`, procedure:`calibrate-joint-range`,
bindings:{arm:deviceName}); migrate its permission key to `calib_compute`.
Replace sampler `routine` with a node or procedure/bindings, then reuse `run`.
Replace `calibrate-joint-range-workspace` with `calibrate-joint-range` or
`calibrate-world-geometry`. No compatibility aliases are provided for these renamed
calibration commands and procedures.

Except for legacy ROS profiles described above, existing profiles and historical
calibration files remain unchanged. Old evidence
can be explicitly referenced after checking provenance; it is not automatically
promoted to a completed plan. Removing setup leaves core devices operational.
Unregistering a device preserves new attempt history; affected plan requirements
become missing/stale. Native plugin snapshot adoption is separate work.

From the repository root run `npm run typecheck`, `npm test`, `npm run test:core`,
`npm run test:setup`, then `npm run build` and `npm run pack -- OUTPUT_DIRECTORY`.
Builds and consumer tests run sequentially. Tests use synthetic evidence and fake
drivers; physical and live simulator validation are separate. Nothing is published.

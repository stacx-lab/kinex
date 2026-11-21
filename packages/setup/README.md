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
import { createKinexSetup, setupContribution, setupLibRoots, setupSkillRoots, setupToolNames } from "@kinex/setup"

const runtime = createKinexRuntime({
  directory: process.cwd(),
  builtinSkillRoots: setupSkillRoots,
  builtinLibRoots: setupLibRoots,
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
Custom setup composition explicitly supplies `setupSkillRoots`, `setupLibRoots`,
`setupToolNames` and its setup contribution. Omitted values do not inherit standalone's defaults.

Device preparation, including ROS dependencies and Kinex Python for ROS, follows
core's [setup-device](../core/assets/builtin/skill/setup-device/SKILL.md) skill.
Nodes consume core runtime modules to remain operational without setup.

## Tools, library and workflows

The `setup_plan` tool reads and saves the DAG, selects a task's targets and records
evidence-backed outcomes. Measurement runs in exec programs through
`kinex.lib.calibration`, which `setupLibRoots` adds to core's function library:
calibration runs, sampling and the solvers (`rigid`, `tcp`, `camera`, `sensor`,
`base`). A program can move, wait, sample and solve in one call; the `lib` tool
reads each function's contract without starting Python. Sampling settles on measured
joint or odometry velocities; see the
[sampling contract](../../docs/setup.md#task-prerequisites-and-calibration-evidence).

`/onboarding [objective]` prepares the embodiment and follows only the requested
objective's prerequisite subgraph. Without a task it prepares profiles/nodes and
reports possible next steps, leaving measurements deferred. `/calibrate [scope]`
resumes selected measurement work; it never exhausts an unrelated backlog.

Core owns `profile_write`, `setup-device`, registration, device configuration and operation execution,
load/unload, topic/service operations, motion and stop. Prepare profiles/nodes incrementally
before measurement. Apply accepted results through `profile_write`; clear requests
explicitly only when their whole section is resolved. Translation-only TCP evidence
may satisfy a task while its orientation request remains open.

Hosts can pass `setupPermissionDefaults` to `kinexPermissionAction`: local plan
mutations default to `setup_plan: allow`. Explicit rules take precedence. Sampling
and solving run under the exec approval; physical operations use existing core
permissions. Public package APIs are trusted
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
Record required node/model files as inputs; plan inspection checks their presence.
Planning never resolves models or reads hardware.

A task has `objective`, `targets` (node IDs), and optional direct `facts`. Only the
targets and their transitive prerequisites are required now. Empty targets can
express a task requiring no calibration. `task:null` defers all measurement work.
The default view collapses deferred and completed work; `full:true` includes nodes,
procedure descriptors and the plan format, which the tool's schema leaves out.
`taskSatisfied` concerns declared requirements, not a certification that the robot
can safely accomplish the task.

Save/select/record require the returned revision. Invalid references, cycles,
participant mismatches and missing producer dependencies are rejected. Outcomes
are `done`, `partial`, `failed` or `needs-input`; observation also derives `ready`,
`blocked` and `stale`. Completion requires existing evidence and expected outputs.
Completed nodes become stale when required facts, outputs, evidence files or completed
prerequisites are missing, including when an explicit profile value no longer matches.
Content changes, node-definition edits and re-recorded completed prerequisites alone
do not invalidate receipts. Reassess their relevance when modifying a completed plan.
Receipts contain status, note, evidence and time. A solver result cannot complete a
node when its computation or quality failed, or before its resolved values are
applied. Malformed deferred procedures are reported without gating unrelated tasks.

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
      "outputs": [{"kind": "profile", "device": "camera", "pointer": "/runtime/nodes"}]
    }],
    "task": {"objective": "View camera images", "targets": ["camera-access"]}
  }
}
```

Archive the connection/static/live verification evidence, then record the outcome.
This example checks declared output presence; the agent must choose and substantiate
checks appropriate to the actual interface, rather than treating file existence as
proof of live connectivity.

Runs live in `.kinex/calib/<run-id>/` with a manifest of the procedure and its
bindings, `samples.json`, artifacts, saved evidence and numbered solver results with a
latest `result.json`. `lib.calibration.start` opens a run and `resume` reopens it by
ID. Only bound devices are sampled; camera images are archived before a sample is
appended, and solvers archive their inputs. Old samples are preserved; record
exclusions with `run.save`.
Results separate computation, quality, resolved fields, unresolved facts and the
`proposed` patch. Failed quality proposes no writes. Warnings require review against
task accuracy. If the user explicitly requests keeping an over-limit result during
setup, honor that request without refusing or forcing recollection due to the error.
When requested, apply computed fields from the result's data with `profile_write`,
preserving frame conventions and validation. Save the errors, limits and user
decision; retain the original quality assessment and do not mark a failed-quality
node done. Record the returned numbered `evidence` path after applying and verifying
accepted changes; later solves do not overwrite that evidence.

`setup.plan` exposes `inspect`, `save`, `select` and `record`.

## Procedures and embodiments

Measurement skills have a `procedure.json` declaring concrete roles, applicable
types, distinct participants, parent relationships, required profile pointers,
produced fields and quality criteria; each skill names its `lib.calibration`
solver. Setup reads the sidecar from the skill directory selected by core
discovery. Custom skills without sidecars remain usable with explicitly authored
requirements/evidence. Custom computations run in exec and archive their evidence
in a run.

| Skills | Coverage |
| --- | --- |
| `calibrate-camera-intrinsics`, `calibrate-camera-extrinsics` | Color image geometry and camera mounting. |
| `calibrate-tcp-offset` | Gripper or suction tool-tip translation; orientation is separate. |
| `calibrate-fixed-arm-mount`, `calibrate-dual-arm` | Rigid parent/arm or cross-arm transforms. |
| `calibrate-joint-range`, `calibrate-world-geometry` | Joint/model limits and independently measured environment geometry. |
| `calibrate-gripper-grip` | The grip joint and its open and closed positions. |
| `calibrate-sensor-bias` | IMU gyro/accelerometer and force/torque bias from static readings. |
| `verify-base-interface`, `verify-base-motion`, `verify-base-posture` | Selected locomotion-base conventions, motion response, expiry/stop and posture references, evaluated with `lib.calibration.base.verify`. |

Fixed arms, dual arms, wheeled manipulators, quadrupeds with arms and humanoids use
actual endpoint/frame compositions. Moving torso attachments and body/heading
frames remain explicit. Base procedures are selected as needed; they do not require
all axes to be calibrated before any base operation. Normalized commands retain
their units. No gait tuning, odometry optimization or inferred motion limits.

Collect incrementally, reuse suitable factory/model/simulator facts and stop when
minimum evidence, coverage and quality meet the task. Explicit tolerances are
required for verification measurements; missing references remain incomplete.
Device preparation follows core's `setup-device`, verifying the declared operations,
input rejection, stop and teardown; failed checks leave onboarding incomplete.
Base procedures evaluate their checks with `lib.calibration.base.verify`, whose
docstring defines the check format.

## Checks

Existing calibration evidence can be referenced after checking its provenance; it is
not automatically promoted to a completed plan. Removing setup leaves core devices
operational. Unregistering a device preserves run history; affected plan
requirements become missing or stale.

From the repository root run `npm run typecheck`, `npm test`, `npm run test:core`,
`npm run test:setup` or the full `npm run check`, then `npm run build` and
`npm run pack -- OUTPUT_DIRECTORY`.
Builds and consumer tests run sequentially. Tests use synthetic evidence and fake
device hosts; physical and live simulator validation are separate. Nothing is published.

## License

Licensed under the [Apache License, Version 2.0](LICENSE).

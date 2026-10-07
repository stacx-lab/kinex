# Current work

## Version 0.10.2

- [x] Bump VERSION for world-wait recovery and IK continuity improvements.
- [x] Synchronize all three package versions, internal dependency pins and the lockfile.
- [x] Validate the separate PR branch against main.

Validation on Node 22.19: version consistency, all 273 tests in `npm run check`,
packed consumers, PTY integration, release validation for `v0.10.2` and diff
checks passed. Native GPU replay was not performed.

## Servo travel checks and IK continuity

- [x] Normalize rotary IK solutions within limits and compare verified candidates within existing search budgets.
- [x] Seed and plan servo from one measured state; check caller-selected travel limits before submission.
- [x] Add opt-in max_joint_delta and recorded dual-shoe motion regressions.
- [x] Complete core, integration, packed-consumer and diff checks after making the travel cap opt-in.

The travel cap applies only when max_joint_delta is supplied; omission imposes
no travel cap. IK normalization and nearest-candidate selection remain enabled.
Servo remains asynchronous.
Usage guidance, closed_loop behavior and RoboEnv are unchanged. This preflight
check does not diagnose native velocity spikes or guarantee collision avoidance.

Validation: Node 22.19 `npm run check` passed all 273 tests, including runtime,
PTY and packed-consumer checks, with 20 Python IK/controller regressions.
Diff checks passed. Native GPU replay was not run.

## World wait timeout recovery

- [x] Cancel timed-out world waits individually and reuse the driver timeout for recovery.
- [x] Cover recovery, concurrent waits, cancellation races, failure cleanup and public timeout errors.
- [x] Complete Kinex checks and RoboEnv CPU cancellation/clock checks.

The per-call deadline remains 60 seconds by default, configurable through
`access.driver.timeout_s`; cancellation reuses that budget instead of a separate
fixed grace period. Successful cancellation preserves the driver;
`wait_timeout` reports no elapsed simulation time. No workspace migration is required.

Validation: Node 22.19 full check passed all 270 tests, including the new timeout
regressions, packed consumers and PTY integration. RoboEnv's existing CPU clock
and motion suites passed all 39 tests. Diff checks passed; no native GPU replay
was run and no RoboEnv sources changed.

## Version 0.10.1

- [x] Bump VERSION and synchronize all package versions, internal pins and lockfile.
- [x] Validate version consistency, release tag matching and version regression tests.
- [x] Remove the invalid-version test containing 0.10.0 fixtures as requested.

Validation: Node 22.19 version and release checks passed; all three remaining version tests
and diff checks passed.

## Velocity usage clarification

- [x] Explain automatic velocity expiry, retained posture and when an explicit stop is useful.
- [x] Shorten feedback guidance while retaining units and frame semantics.

Validation: documentation-only diff checks passed; no links or runtime behavior changed.

## Closed-loop tool simplification

- [x] Rename track to closed_loop across built-ins, context, rendering and consumers.
- [x] Make all four stages optional; omitted/null stages return an empty dict.
- [x] Default missing predicate done to false and document minimal fixed-target calls.
- [x] Add optional-stage, predicate-validation and renamed-consumer regression coverage.
- [x] Complete the full check and documentation/diff validation.
- [x] Keep servo, run_policy and FastWAM guidance independent; closed_loop owns feedback-loop rationale and composition recipes.

The rename has no compatibility alias; refresh copied workspace tools explicitly.
Servo timing and repeated-trajectory replacement behavior are unchanged.

Validation: Node 22.19 full check passed all 258 tests, including packed consumers
and PTY integration. Diff checks passed. Checked local documentation links resolve
except the pre-existing unavailable sibling plugin README. The existing user edit
to the joint device guide is preserved.
The subsequent guidance-only revision passed manifest-schema, independent-guidance,
link and diff checks; the same pre-existing sibling README link remains unavailable.

## RoboEnv launch success policy

- [x] Add --stop-on-success / --no-stop-on-success and Python stop_on_success overrides.
- [x] Preserve YAML policy when omitted; persist explicit overrides in worker definitions.
- [x] Validate booleans and supported backends before provisioning or starting processes.
- [x] Document CLI/Python usage and pass 89 focused policy/lifecycle tests.
- [x] Complete RoboEnv CPU, privacy and wheel checks.

Validation: full RoboEnv check passed 1,253 tests (35 skips), lint, privacy and
SDK/runtime wheel checks. CLI help exposes both mutually exclusive flags;
tests cover YAML precedence, retained worker configuration and early rejection.

## SIMPLE task catalog in RoboEnv

- [x] Include all 12 decoupled GR00T tasks with native language instructions and concrete default target names.
- [x] Default catalog/discovery to realtime and stop_on_success to false, matching LIBERO.
- [x] Retain native success without freezing control; let the worker own automatic stopping.
- [x] Pin and prepare articulated assets and four additional HSSD scenes.
- [x] Check all native predicates, catalog bindings and asset dependencies on CPU.
- [x] Complete RoboEnv checks and the two requested Isaac boot/control probes.

Implementation is in sibling RoboEnv. Robot profiles and current workspace connections
are unchanged by this task. Isaac scope is open-oven and pick-and-place-and-hug-container;
startup/control checks do not establish task-solving success.

Validation: RoboEnv check passed 1,234 tests (35 skips), lint, privacy and both
wheel checks. Both Isaac probes passed 60 intervals of stereo/base/arm/hand
checks and exited normally. All 12 default asset dependencies were audited,
five articulated MuJoCo models compiled, and extracted assets passed checksum
verification after the probes. Local evidence is retained under RoboEnv's
`.cache/simple/catalog-validation.json`; no task-solving or fresh replay claim.
The subsequent realtime-default revision passed 103 focused tests (1 skip),
catalog regeneration and diff checks; the two native probes above used stepped.
Catalog instruction targets now resolve from effective native defaults, including
the hug task's constructor override to apple; fixture instructions retain the
object used by their success predicate. This revision passed 85 focused tests
(1 skip), lint, regeneration and diff checks.

## Servo hand support

- [x] Accept dexterous hands in servo discovery and execution with the existing joint planner.
- [x] Keep pose goals gated by declared endpoint IK and document hand usage.
- [x] Verify hand trajectories, replacement/stop semantics and pose capability checks.

Validation: Node 22.19 core build and all 154 core tests passed. Runtime tests
exercise hand trajectory submission, retained targets, replacement and stop;
pose tests cover declared IK and reject fingertip-only geometry before writes.
Diff checks passed.

## Simplified hand profiles

- [x] Use named chain joints; remove redundant palm/reference selectors and joint lists.
- [x] Support physical descriptions, optional finger geometry and optional centers.
- [x] Update Kinex FK/frame discovery and RoboEnv generation/export without changing control.
- [x] Verify schema, frame semantics, old/new FK equivalence and native CPU geometry.
- [x] Complete sequential repository checks and document migration results.

Joint control and measured feedback remain unchanged. Existing profiles require
explicit migration and matching copied Python resources; native plugin snapshots
remain separate. Grasp planning, posture libraries and the obsolete grasp.target
helper are deferred.

Validation: Node 22.19 full Kinex check passed 251 tests, including packed consumers.
RoboEnv lint, 1,208 tests (35 skips), privacy audit and both wheel checks passed.
Old and simplified G1 profiles produced identical fingertip and center poses over
208 deterministic configurations. The native MuJoCo CPU probe passed 102
configurations with maximum transform error 2.0e-15. Each hand profile is 66 lines
shorter; fixed frames, tip offsets and joint metadata are preserved. These checks
do not establish grasp success or GPU replay. Diff checks passed; documentation
links resolve except the pre-existing unavailable sibling plugin README.

## Gripper hold and test consolidation

- [x] Retain applied gripper references at stop, including buffered hardware drivers.
- [x] Unify scalar-gripper stop across all six RoboEnv backends; keep reset separate.
- [x] Add CPU stop contracts and Panda contact/preload regression coverage.
- [x] Build once per full check; share packed-consumer preparation and remove duplicate matrices.
- [x] Drive PTY transitions by observed output; shorten only test-owned deadlines.
- [x] Complete full checks and timing comparison; verify relocated consumers and local packaging.

Validation: Node 22.19 full check passed 247 tests, including core-only installation,
setup removal, standalone relocation and real PTY interaction. One build/typecheck
pass plus tests and package metadata checks took 51.6 seconds; tests took 38.2 seconds
versus the prior existing-build run's 42.1 seconds. PTY cases totaled about 14 seconds
versus 24 seconds. The CI path now builds each package once instead of rebuilding
core four times and setup three times.

RoboEnv's complete check passed 1,105 tests with 40 optional skips, privacy audit and
both wheel gates in 135.0 seconds. Its test phase took 132.4 seconds versus the prior
164.8-second run. These are local single-run measurements, not a CI latency guarantee.
Removed duplicate coverage remains represented by the shared package stages, three
recording cases, one CLI service-selection scenario plus in-process rejection cases,
both scheduler modes, one owner-thread Kinex composition, and four kitchen builds
across two processes.

The isolated native Panda contact fixture retains its grasp through wait, stop and
translation, and releases on explicit open. The former measured-position stop is
its dropping negative control. Native Panda/Omron checks also retain the gripper
integrator target while moving the arm. This does not certify kitchen-task success
or GPU replay. Refresh copied hardware gripper drivers and runtime helpers, then
reload; restart owned RoboEnv services. Existing third-party working edits are preserved.

## Version 0.10.0 preparation

- [x] Install pinned camera dependencies in PR/release CI and fresh local test environments.
- [x] Make VERSION authoritative; add explicit sync and read-only consistency commands.
- [x] Synchronize package versions, internal pins and lockfile; derive CLI output from installed metadata.
- [x] Validate drift rejection, idempotence, third-party lock preservation and relocated packages.
- [x] Complete fresh Python 3.12 / Node 22.19 typecheck, 149 core, 27 setup and 74 standalone tests.
- [x] Build and pack all three 0.10.0 tarballs locally.

Future bumps edit VERSION and run `npm run version:sync`, then commit the generated
metadata. `npm run version:check` and release tag checks reject drift without writes.
The original device-contract snapshot remains in its own commit. This prepares
source and local artifacts; no tag, GitHub release or registry publication is created.
Hosted validation is tracked by the PR checks on each pushed commit.

Bounded DLS restarts shared by servo and Cartesian policy actions are complete.

## Bounded IK search

- [x] Add deterministic local/broad seeds, cooperative budgets and cancellation.
- [x] Prefer the nearest verified candidate after normalizing equivalent rotary angles.
- [x] Add optional profile settings, diagnostics and operating guidance.
- [x] Add controlled-clock, numerical, controller and packaged-runtime coverage.
- [x] Re-run the self-contained Panda benchmark and waypoint sequences.
- [x] Complete typecheck, standalone/core/setup suites, build and local packaging.

Current IK continuity and servo validation are tracked above. Candidate search
keeps its existing time and attempt budgets; successful initial solutions now
compete with later candidates, so latency can increase within those budgets.

Reproduce with `PYTHONPATH=packages/core/assets/python python3 packages/core/test/benchmark_ik.py --output /tmp/kinex-ik.json`.
Existing profiles inherit the defaults. Reload persistent drivers after upgrading;
refresh workspace-local Python overrides together before reloading. Native plugin
core snapshots remain an independent update.

Simplify servo and relative_pose results while preserving device and frame contracts.
Refactor velocity-device feedback and native input limits across Kinex and RoboEnv.

## Tool compatibility with device protocols

- [x] Separate settled sample freshness from world-time stability and timeout.
- [x] Preserve structured device failures through tools and Python composition.
- [x] Project initial policy IK seeds; return execution_ids instead of writes.
- [x] Remove redundant builtin policy/localization capability prerequisites.
- [x] Support hand settling, archive RGBD depth, and retain FK after settle timeout.
- [x] Add regression coverage and update contracts and migration guidance.
- [x] Complete sequential typecheck, standalone, core and setup checks.

Validation on Node 22.19: typecheck, 70 standalone, 147 core and 27 setup tests
passed. Diff checks passed; documentation links resolve except the existing
link to the unavailable sibling plugin checkout. Policy consumers must replace
`writes` with `execution_ids`; settled state without `sample_timestamp` restarts
its stability interval while retaining its timeout.

## Relative pose results

- [x] Return only pose, path and estimated_links; retain the Python frames.pose() contract.
- [x] Update output-shape and transform tests, tool guidance and public documentation.
- [x] Run core tests and documentation/diff checks.

Validation on Node 22.19: all 141 core tests passed, including transform inversion,
identity, quaternion normalization, estimates and closed_loop-to-servo composition.
In-repository documentation links and `git diff --check` passed.

## Servo results

- [x] Forward execution_id at the top level; remove end_joints and nested write feedback.
- [x] Update result-shape, execution-ID forwarding and continuous-joint coverage and documentation.
- [x] Verify invalid feedback handling and run core tests and documentation/diff checks.

Validation on Node 22.19: typecheck, 70 standalone and 25 setup tests passed.
The core suite passed all 140 existing tests; after correcting the new regression's
fixture, all nine servo-focused tests passed, including invalid-feedback cleanup.
In-repository documentation links and `git diff --check` passed; the existing
sibling plugin-checkout link cannot be resolved in this environment.

## Completed device guidance

- [x] Shorten all 13 device Use sections to essential operating conventions.
- [x] Keep device-use.txt general; move type-specific conventions into device guides.
- [x] Keep setup-device shared; retain type-specific setup requirements in DEVICE.md.
- [x] Validate guide parsing, profile examples, relative links and diff formatting.

Combined Use text reduced from 2,424 to 1,080 words.

## Velocity-device feedback and native limits

- [x] Remove global pose feedback across Kinex and RoboEnv; preserve body measurements and useful local frames.
- [x] Keep named-axis writes, improve errors and publish RoboCasa's native normalized input bounds.
- [x] Preserve explicit frame estimates and unlocalized-root readiness.
- [x] Update documentation and fixtures; verify contract, frame, native CPU and package checks.

Validation: Node 22.19 typecheck, standalone/core/setup suites (corrected frame-test
fixture rechecked), native RoboCasa CPU checks, build and local tarballs. RoboEnv's
full check passed with 1,064 tests and 40 skips, privacy audit and wheel checks.
GPU replay was not run. Existing copied workspaces need refreshed base profiles
and drivers, a restarted RoboEnv service and a base reload.

## Failed-write cleanup

- [x] Add execution-scoped local buffer cancellation, including retained positions.
- [x] Cancel failed post-submission feedback and preserve structured cleanup failures.
- [x] Update RoboEnv actuator adapters, catalog resources and stale documentation.
- [x] Complete regression and integration checks across both repositories.
- [x] Complete final Kinex build and local packaging.

Validation: Node 22.19 typecheck; 70 standalone, 139 core and 25 setup tests.
RoboEnv's CPU/source/package checks passed with 1,087 tests and 40 skips,
including cleanup regressions, privacy audit and wheel checks.
Final Kinex build and local tarball packaging passed.

Refresh copied actuator drivers and shared RoboEnv transport resources, then reload
upgraded devices. Existing native GPU validation remains separate.

## Model-defined joint frames

- [x] Discover computed endpoint and hand frames from their models without duplicate placeholders.
- [x] Update frame resolution, profile validation, RoboEnv profile builders and catalogs.
- [x] Update guidance and add regression coverage.
- [x] Complete cross-repository suites and packaging checks.

Validation: Node 22.19 typecheck; 70 standalone, 140 core and 25 setup tests;
final build and local tarballs. RoboEnv checks passed with 1,088 tests and 40 skips,
including catalog/driver conformance, privacy audit and wheel checks. GPU replay
was not run.

Existing workspaces need migrated profiles and refreshed runtime/driver resources,
then device reloads; preserve connection and calibration settings.

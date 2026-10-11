# Current work

## ROS baseline and dependency simplification

- [x] Remove the apt model tool, terminal handoff, setup host callbacks and inherited stdin.
- [x] Keep apt dependency checks read-only; use the existing shell tool or user-run sudo commands.
- [x] Preserve pip/Git/colcon preparation, ROS adapters, generation recovery and application composition.
- [x] Rebase PR #24 onto main at e434f5f and resolve conflicts.
- [x] Drop Humble/Python 3.10 compatibility and its CI job; use Jazzy/Python 3.12 fixtures and guidance.
- [x] Restore core cleanup to main and use native subprocess process-group options.
- [x] Validate the simplified baseline and prepare the PR #24 update.

ROS implementation stays in setup. Core retains only the CRLF parsing change.
Setup adds four skills and no new apt tool or ROS command. Supported ROS setup is
Jazzy on Ubuntu 24.04 with system Python 3.12; detection never guesses an unlisted
distribution. Bundle provisioning checks apt dependencies without installing them;
`--install` enables pip/Git preparation and source builds after prerequisites pass.
The agent hands sudo-required commands to the user on the driver host and verifies
dependencies afterward.

Validation: Node 22.19.0 / Python 3.12.13 `npm run check` passed all 357 tests,
including build/typecheck, ROS helpers, PTY, packed consumers and release checks,
with no skips. Distro-selection coverage rejects Humble and does not autodetect
unlisted installations. The Jazzy-only smoke script passes shell syntax checking
and rejects the former distro argument before invoking Docker. Diff checks passed;
17 local documentation paths were checked, with only the existing unavailable
sibling plugin README unresolved. Native ROS container tests were not rerun.

The existing FastWAM inference environment on main is separate from this ROS
compatibility change. Vendor-specific production bundles, physical robots and real
ros2_control validation remain deferred. Native plugin snapshots remain independent.

## Active session time

- [x] Show cumulative active time in the existing footer stats row.
- [x] Exclude idle periods and user-input dialogs, and restore saved intervals on resume.
- [x] Count pre-prompt automatic compaction, including failure and cancellation, without double-counting active runs.
- [x] Validate the pre-prompt compaction timing fix.
- [x] Keep timing entries out of model context and preserve recording indicators.
- [x] Validate timing, application lifecycle, terminal rendering and packed consumers.

Validation: `npm run check` passed all 310 tests, including build/typecheck,
timing persistence, model-context isolation, regular/fullscreen PTY rendering,
packed consumers and release checks. Diff checks passed.
The pre-prompt timing fix passed `npm test`: build/typecheck and all 91 standalone
tests, including success/failure/cancellation timing, overlapping activity, PTY
rendering and packed consumers. The three new integration cases failed before
the fix and passed afterward.

## Short slash commands

- [x] Remove standalone `kinex-` aliases and expose each Kinex command by its short name only.
- [x] Remove Kinex's reload command, input interception and device autocomplete; Pi exclusively owns `/reload`.
- [x] Audit Pi 1.1.0 built-ins, built-in extension commands and bundled plugins: no remaining command-name overlaps.
- [x] Verify short command registration, device commands, Pi resource reload and PTY behavior.

Users restart devices with unload followed by load. Programmatic `devices.reload()`
remains available; the shared user-command executor rejects `reload`.
Validation: `npm run check` passed all 336 tests on Node 22.19.0 and Python 3.12,
including real PTY execution of Pi's `/reload` and packed-consumer checks.

## Pi 1.1 and package management

- [x] Upgrade standalone Pi SDKs to 1.1.0 and bundled web search to 1.7.0; retain current BTW 0.7.1.
- [x] Enable Pi package extensions, skills, prompts and themes alongside Kinex robotics resources.
- [x] Add install/remove/uninstall/list/update commands using Pi's package manager and isolated Kinex settings.
- [x] Add checksum-verified GitHub release upgrades for npm installs and `--all` handoff to the new CLI.
- [x] Cover npm/Git packages, pins, scopes, resource loading, nested tool permissions/cancellation and recording attribution.
- [x] Exercise release failures and a real local npm upgrade with fixture tarballs.
- [x] Pass full integration, PTY and packed-consumer checks on Node >=22.19.

Validation after rebasing onto main (`caac19a`): `npm run check` passed all 336
tests on Node 22.19.0 and Python 3.12, preserving upstream active-session timing,
including packed consumers and a real npm upgrade using fixture releases. Updated
the Anthropic audit for Pi's inline tool definitions and verified stable request
prefixes across additions, removals and redefinitions. Live provider calls were
not required; provider request checks use local fixtures.

Azure users must migrate the provider ID to `azure`; credentials are not rewritten
automatically. Project package artifacts follow Pi's `.pi` layout; Kinex retains
separate declarations. Source/linked self-upgrades provide manual instructions.

## Version 0.10.3

- [x] Validate all 13 RoboEnv catalogs (89 profiles), exported drivers and blocking servo against current Kinex.
- [x] Bump VERSION and synchronize all package versions and internal dependency pins.
- [x] Pass the full integration check (307 tests) and validate the v0.10.3 tag against VERSION.

The compatibility audit exercises schema/action contracts, driver transport,
IK seeds and the stepped world clock. Duration waiting does not imply measured
arrival; native application may finish on the following simulator tick.

## Servo and nearby IK stacked on PR #18

- [x] Review and adapt local changes onto the updated hardware-onboarding branch.
- [x] Use only nearby IK retry seeds; retain five attempts and rename ik.search to ik.budget.
- [x] Remove max_joint_delta and add optional world-clock blocking without planner services.
- [x] Preserve the parent branch's fixed 1° inward home recovery and plain home maps.
- [x] Validate the combined branch before publishing a PR targeting dev-go2-onboarding.

Validation: Node 22.19 `npm run check` passed all 307 tests and packed-consumer
checks. Coverage includes nearby-seed motion regressions, fixed home recovery
with pose goals in both blocking modes, world-clock waiting, timeout and
ownership-aware cancellation.

Refresh copied tools/Python helpers and reload persistent drivers when adopting
these changes. External plugin snapshots remain separate. No RoboEnv edits or
physical robot runs are included in this PR.

## PR #18 merge preparation

- [x] Merge main, retaining v0.10.2 fixes and resolving dependency conflicts.
- [x] Restore plain home maps and use a fixed 1° inward home-recovery margin.
- [x] Complete the legged_base rename across profiles, runtime and guides.
- [x] Pass full checks before publishing the updated PR head.

Validation: Node 22.19 `npm run check` passed all 298 tests, build/typecheck,
PTY and packed-consumer/release checks. Home recovery and legged-base discovery
passed; compaction assertions now match the reduced contributed context.
No physical robot or live provider calls were made.

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

## Smaller injected context

- [x] Remove core.devices, core.readiness and setup.plan from contributed model context.
- [x] Update registration guidance and existing context assertions.

Validation: workspace build/typecheck and the focused setup composition test passed.
Existing session history retains previously injected sections.

## Custom device guide authoring

- [x] Allow custom per-device DEVICE.md authoring only for legged_base in setup, runtime guidance and documentation.
- [x] Reject per-device guides outside the legged_base allowlist before injecting runtime context.
- [x] Cover rejected types, allowed guides, shared fallback, edits and recovery after removal.

Validation: core build/typecheck, both focused guide tests and scoped diff checks
passed. The device-management suite passed 10 of 11 tests; guide discovery fails
in the earlier partial rename; the PR preparation completes the schema and template rename.

## RGBD setup guidance

- [x] Remove shared setup repetition and consolidate capture/recording instructions.
- [x] Preserve calibration contracts, metadata and Use guidance; omit derived FOV from the starter profile.

Validation: guide references, Markdown fences and scoped diff checks passed;
FOV defaults in the schema and has no built-in downstream task consumers.
Use text is unchanged. Documentation-only change.

## Velocity setup guidance

- [x] Keep SDK conversion, actual observations and stop-scope rules in setup-device.
- [x] Document velocity profile fields, buffered hooks, halt-on-expiry and focused checks.
- [x] Clarify required command channels, posture defaults and feedback absence in Use.

Validation: Kinex parsers preserve metadata and the unchanged starter YAML;
profile validation, guide separation and relative-link checks passed. Local
validators cover documented commands/feedback, missing posture, unsupported or
missing axes, invalid durations, dynamic frames and stop scope. Diff checks
passed; no hardware or model calls were made.
Cross-checked all four RoboEnv base profiles: locomotion combines velocity and
posture, while drive is velocity-only. The guide's Go2-shaped moving and stationary
commands both pass Kinex validation under the same locomotion mode.

## Setup-device skill simplification

- [x] Shorten setup-device to guide selection, provisioning, driver obligations and focused verification.
- [x] Remove migration history, protocol internals and duplicated type guidance; correct buffer replacement wording.
- [x] Preserve discovery metadata, activation rules, cancellation and resource ownership.

Validation: reduced the skill from 1,305 to 656 words. Kinex frontmatter parsing
preserves all metadata; referenced helpers and guides exist. Reviewed new-device,
driver-repair and separate-interpreter workflows against current contracts.
Documentation diff checks passed; no runtime, hardware or model tests were needed.

Compact revision: 686 → 535 words, with driver obligations grouped by contract.
Preserved current working edits and metadata; Kinex parser and scoped diff checks
passed. Generic skill validation rejects the existing Kinex-only `resolves` field.
Cancellation guidance now distinguishes request-local checks between bounded SDK
operations from background workers' own stop/cancellation mechanisms; checked
against the current helper implementation and passed scoped diff checks.

## PR #18 integration on main

- [x] Rebase only the 13 commits after 33d20de; exclude the already-merged old target.
- [x] Preserve 0.10.1 versions and internal pins while retaining setup's extension dependencies.
- [x] Retain receipt simplification and robot-context changes; correct contracts and migration guidance.
- [x] Clarify joint home recovery, position-based settling and the legged instance guide.
- [x] Complete full integration, version, documentation and diff checks.
- [x] Verify the rebased range excludes already-merged work and preserves runtime implementation.
- [x] Retarget PR #18 to main and confirm GitHub reports a conflict-free merge.

Validation: Node 22.19 and Python 3.12 full check passed all 281 tests, including
PTY interaction and packed consumers, plus build/typecheck and release metadata
checks. Version and diff checks passed. All 15 checked relative documentation
links resolve except the pre-existing unavailable sibling plugin README.

## Default web search and BTW

- [x] Bundle the workspace's pi-web-search 1.6.0 and pi-btw 0.7.1 in setup.
- [x] Export setup-owned package locations for standalone's default extension loader.
- [x] Load upstream extensions by default while honoring explicit npm package settings.
- [x] Document search availability and BTW child-session behavior.
- [x] Validate startup, reload, child sessions and packed standalone installation.

Validation: build/typecheck and all 85 standalone checks passed with Node 22.22.2
and Python 3.11, including default/explicit extension loading, BTW read-only
child sessions, PTY interaction and relocated package consumption. Version and
diff checks passed. No live provider search requests were made.

After moving dependency ownership to setup, build/typecheck and all 13 focused
extension/package checks passed, including setup-only installation, exported
plugin locations after relocation, standalone loading and shared credentials.

## Robot context safety fields

- [x] Remove safety limits, keep-out zones and notes from the robot context summary.
- [x] Remove safety.notes from the workspace manifest schema.
- [x] Validate the core build, context/manifest smoke checks and diff formatting.

Validation: core build/typecheck and smoke checks passed. With Python 3.11,
167 core tests passed; two camera tests failed because that interpreter lacks
NumPy. The default Python 3.8 also fails existing modern-Python code.

## Setup receipt simplification

- [x] Remove unused definition, input, output, evidence and dependency hashes from plan receipts.
- [x] Read existing receipts without their old hash fields; drop them on the next plan write.
- [x] Retain calibration attempt/result fingerprint checks and plan fact validation.

Validation: core/setup build and typecheck, all 28 setup tests, and changed-file
diff checks passed. Tests were rerun outside the sandbox after its Python spawn
restriction blocked the URDF test.

## Legged transition stop scope

- [x] Clarify that stand/crouch transitions need not be interruptible; align setup and driver guidance.

Validation: changed-file diff checks and scaffold syntax passed; runtime unchanged.

## Unregister unloaded devices

- [x] Make stop cleanup idempotent when the driver is inactive, matching unload.
- [x] Cover never-loaded drivers and unregister after explicit unload.
- [x] Preserve lifecycle fences, recording cleanup and real deactivation errors.

Validation: core build/typecheck and all ten device-management tests passed,
including unloaded persistent/one-shot drivers without an available interpreter.
The scheduler regression and 19 of 20 focused runtime checks passed with system
Python. The remaining persistent-driver close check passed when rerun with Python
3.11 instead of the unsupported system Python 3.8.

## Extension child-session credentials

- [x] Keep credentials in data storage and provide a managed Pi agent-directory auth link.
- [x] Use the same credential entrypoint and OAuth lock in the host and SDK-default child sessions.
- [x] Preserve conflicting auth files; cover concurrent startup, empty SDK files and credential updates.
- [x] Complete final standalone validation and remove the local btw workaround.

Validation: build/typecheck and diff checks passed. The standalone run passed 73
checks; ten failures (including the package parent result) used unsupported system
Python 3.8. With Python 3.11, all 24 auth, extension, shutdown, PTY and packed-consumer
checks passed, including the final auth changes. The installed btw extension is
restored to its original version. Restart Kinex to establish the managed auth link;
real provider requests were not used for validation.

## Calibration acceptance guidance

- [x] Align tool guidance and workflow stopping conditions with user-accepted approximate results and accuracy/time budgets.
- [x] Preserve measured errors, original quality assessments and invalid-result exclusions.

Validation: documentation diff checks passed; no links added or changed.

## Legged base template

- [x] Add an independent legged_base template requiring a custom instance Use guide.
- [x] Describe minimal SDK states/skills, measured readback and explicit writes.
- [x] Seed crouched_down and drive; add states/optional skills only for user needs.
- [x] Declare control.device_modes and use mode consistently for writes and measured feedback.
- [x] Prefer velocity-compatible motion parameters, feedback names and expiry semantics; adapt SDK details in drivers.
- [x] Support SDK-defined writes, optional state graphs and observed state feedback.
- [x] Validate template resolution, profile schema and state-control contracts.

Validation: full workspace build/typecheck, eight device-management tests, three
legged tests (including the SDK mock scaffold), and frame/readiness/architecture/
contribution regressions passed. Vendor SDK hooks remain to be implemented during
device setup; no physical legged was exercised.

## Device-specific context

- [x] Prefer optional per-device DEVICE.md Use sections over type guides.
- [x] Scope guidance to loaded devices and preserve shared fallback precedence.
- [x] Cover edits, removal, invalid overrides, nested discovery and inert Python state.
- [x] Validate core typechecking, device-management tests and diff formatting.

Validation: core build/typecheck and all eight device-management tests passed.
The full core suite was attempted; Python-dependent checks fail with the local
Python 3.8 interpreter (unsupported modern typing and executor APIs).

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

## Version 0.8.2

- [x] Align standalone/core versions, the exact internal dependency, lockfile and CLI.
- [x] Update package installation examples for the two-package release.
- [x] Validate typecheck, standalone/core tests, build and v0.8.2 release artifacts.

Includes FastWAM policy inference, plugin project separation, Pi SDK 0.87.1 and
Python execution without repeated dependency synchronization.
Validation: typecheck, 79 core tests, 53 standalone tests, build, v0.8.2 metadata
and both release tarball checksums passed.

## Python execution without repeated dependency synchronization

- [x] Reuse existing default interpreters; prepare only missing environments.
- [x] Route tools, driver startup, URDF parsing and recording through the same check.
- [x] Keep explicit preparation and coordinate concurrent bootstrap/cancellation.
- [x] Reduce system Python guidance to one paragraph and remove implicit skill syncs.
- [x] Validate preparation races, errors, headless context and full checks/package.

No new commands or onboarding prerequisite. Plugin snapshots remain unchanged.
Validation: typecheck, 53 standalone tests, 79 core tests, build and two-package
release packing with checksum verification passed.

## Standalone Pi SDK update

- [x] Pin pi-ai, pi-coding-agent and pi-tui to npm's latest release, 0.87.1.
- [x] Use canonical session context and the SDK refresh API after compaction.
- [x] Derive the changelog setting from the installed SDK version.
- [x] Validate type checking, standalone/core tests, build and packaging.

Plugin dependencies and their core snapshot remain unchanged.
Validation: typecheck, 52 standalone tests (including PTY, permissions and
compaction), 70 core tests, build and two-package release packing passed.

## Plugin project separation

- [x] Move native Pi, OpenCode and Codex packages to `../kinex-plugins`.
- [x] Give standalone its own Pi integration; remove plugin dependencies.
- [x] Add independent plugin builds, CI and versioned core snapshot consumption.
- [x] Update LIBERO plugin launch paths without restarting hosts.
- [x] Validate independent installs, tests, relocated packages and release artifacts.

The split preserved Pi SDK versions. Core has one source in this repository.
Validation: clean npm installs, typechecks, 52 standalone tests (including PTY),
70 core tests and 36 plugin tests passed. Plugin checks ran in an isolated copy
without an adjacent Kinex checkout. Each plugin installed and relocated with only
its core snapshot. Both projects built and packed independently; LIBERO launcher
paths resolve. No hosts were restarted and no models were loaded.

## FastWAM policy integration

- [x] Add Cartesian policy spaces, rigid tool offsets and seeded buffered IK.
- [x] Add the builtin FastWAM inference service and pinned provisioning recipe.
- [x] Verify core contracts, standalone integration and relocated packaging.
- [x] Provision LIBERO base, Optional IDM and RoboTwin base checkpoints.
- [x] Validate all four inference paths and one ten-action LIBERO chunk.

Validation targets inference and chunk execution, not benchmark task success.
No training, RoboTwin rollout or plugin adaptation is included.

Validation: typecheck, 47 standalone and 70 core tests, build, package relocation
and tarball creation passed. All three checkpoints loaded with complete inference
weights; both Optional IDM modes and both base variants returned finite chunks.
LIBERO consumed ten arm/gripper actions in 0.5 simulation seconds without faults.
RoboTwin used a synthetic observation fixture. The model was unloaded and the
owned simulator stopped after acceptance.

## Version 0.8.1

- [x] Align package versions, internal dependencies, CLI/MCP versions and install examples.
- [x] Verify typecheck, build, 63 core, 47 standalone, 20 Pi/OpenCode and 14 Codex tests.
- [x] Pack all five tarballs and verify their checksums and v0.8.1 tag metadata.

## Focused cleanup

- [x] Keep recording capture in the recorder; simplify timers, promises and frame paths.
- [x] Separate Python tool catalogs from execution and consolidate launch setup.
- [x] Remove redundant smoke tests, formatting/migration checks and extraction fixtures;
  consolidate joint validation and keep behavioral context tests across providers.
- [x] Compare the packaged CLI version with its installed manifest.
- [x] Verify typecheck, 63 core tests, 47 standalone tests, build and packaging.

Tests are 171 lines smaller than the pre-cleanup suite. Queue invalidation uses
deterministic scheduler coverage; runtime coverage retains interruption and recovery.

## Version 0.8.0

- [x] Align package versions, internal dependencies, CLI output and install examples.
- [x] Verify release metadata, rebuild and package all five tarballs.

## Generic tracking

- [x] Compose perceive → process → control, with controller-owned timing.
- [x] Extract point_to_pose and remove observation inputs from move_to.
- [x] Preserve owned cleanup and propagate controller failures as errors.
- [x] Verify compositions, permissions, cancellation and packaging.

Validation: typecheck, 70 core tests, 49 standalone tests, build and packaging
passed. Package contents include point_to_pose and the new track contract.

## Buffered joint control

- [x] Remove driver goal control across Kinex and all RoboEnv backends.
- [x] Plan and verify goal motion in move_to using buffered write.
- [x] Support missing motion limits with documented, configurable planning rates.
- [x] Verify native paths, cancellation, catalogs and packaging.

Planning defaults are 1 rad/s and 3 rad/s², or 0.1 m/s and 0.3 m/s² for linear
joints, always capped by known limits.

Validation: 61 core tests, 10 simulator/RPC checks, core build and npm packaging
passed with these rates. Coverage includes all seven backend fixtures and native
RoboCasa torque dynamics. GPU replay was not run.

## Other remaining work

- [ ] Evaluate persistent Python perception processes using updated measurements.
- [ ] Extract real-world onboarding when its ownership is concrete.
- [ ] Broaden host/platform coverage in a separately requested adapter change.
- [ ] Complete standalone parity priorities: autonomous instructions, bounded
  image attachment handling, task budgets and robotics integration coverage.
  See [FEATURE_PARITY.md](FEATURE_PARITY.md).
- [ ] Address lower-priority command/UI/export/statistics gaps and standalone
  Node releases. See [CONTEXT_AUDIT.md](CONTEXT_AUDIT.md).

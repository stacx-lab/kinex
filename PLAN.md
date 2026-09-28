## Control refactor

- [x] Submit duration-based device buffers and wait through the world clock.
- [x] Compose servo, track and settled, including inline Python stages.
- [x] Share device/devices execution and support frame-attached relative poses.
- [x] Use flat gripper/suction sequences in drivers and policy submission.
- [x] Update RoboEnv catalogs and the LIBERO workspace, retaining FastWAM.
- [x] Slim RoboEnv tests and validate the plugin snapshot.

## Final review

- [x] Remove unused motion helpers, binding metadata and stale test options.
- [x] Simplify local control code without changing runtime behavior.
- [x] Run core, standalone, RoboEnv and packaging checks.

Validation: Kinex typecheck, 83 core tests, 53 standalone tests, build and tarball
checks passed. RoboEnv: 756 passed, 37 skipped; the existing IsaacLab CloudXR
failure was reproduced separately and excluded. Lint, privacy, wheels and all
catalog driver copies passed. Third-party checkout edits remain untouched.

## Other remaining work

- [ ] Evaluate persistent Python perception processes using updated measurements.
- [ ] Extract real-world onboarding when its ownership is concrete.
- [ ] Broaden host/platform coverage in a separately requested adapter change.
- [ ] Complete standalone parity priorities: autonomous instructions, bounded
  image attachment handling, task budgets and robotics integration coverage.
  See [FEATURE_PARITY.md](FEATURE_PARITY.md).
- [ ] Address lower-priority command/UI/export/statistics gaps and standalone
  Node releases. See [CONTEXT_AUDIT.md](CONTEXT_AUDIT.md).

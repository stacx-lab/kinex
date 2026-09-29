## Control refactor

- [x] Submit duration-based device buffers and wait through the world clock.
- [x] Compose servo, track and settled, including inline Python stages.
- [x] Share device/devices execution and support frame-attached relative poses.
- [x] Use flat gripper/suction sequences in drivers and policy submission.
- [x] Update RoboEnv catalogs and the LIBERO workspace, retaining FastWAM.
- [x] Slim RoboEnv tests and validate the plugin snapshot.
- [x] Return policy IK truncation as normal results, including empty prefixes, while keeping track controller-agnostic.
- [x] Document and cover max_actions execution horizons and fresh-observation replanning through track.

## Final review

- [x] Remove unused motion helpers, binding metadata and stale test options.
- [x] Simplify local control code without changing runtime behavior.
- [x] Run core, standalone, RoboEnv and packaging checks.

Validation: Kinex typecheck, 89 core tests, 53 standalone tests, build and tarball
checks passed. RoboEnv: 756 passed, 37 skipped; the existing IsaacLab CloudXR
failure was reproduced separately and excluded. Lint, privacy, wheels and all
catalog driver copies passed. Third-party checkout edits remain untouched.

Policy validation on Node 22.19.0: typecheck, all 53 standalone tests and all
89 core tests passed, including partial/empty-prefix tracking, capped execution
horizons, fresh-observation replanning and package installation/relocation.
No empty-prefix retry limit was added.

## Other remaining work

- [ ] Evaluate persistent Python perception processes using updated measurements.
- [ ] Extract real-world onboarding when its ownership is concrete.
- [ ] Broaden host/platform coverage in a separately requested adapter change.
- [ ] Complete standalone parity priorities: autonomous instructions, bounded
  image attachment handling, task budgets and robotics integration coverage.
  See [FEATURE_PARITY.md](FEATURE_PARITY.md).
- [ ] Address lower-priority command/UI/export/statistics gaps and standalone
  Node releases. See [CONTEXT_AUDIT.md](CONTEXT_AUDIT.md).

## Native simulator limits

Simulator joint and velocity profiles can opt into `control.limit_handling: native`: preflight and
Python command helpers retain structure/finite checks while delegating numeric
range handling. Nullable continuous bounds represent unspecified command bounds.
Other profiles keep existing range checks. Servo retains planning rates and
accepts explicit targets or measured overshoot for native profiles; physical
model geometry and IK constraints remain available.
Scalar grippers keep existing bounds and rejection behavior; no native-limit
option or nullable bounds were added to their schema or Python helper.

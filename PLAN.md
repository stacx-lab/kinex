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

# Current work

Restore device management and provisioning to core; keep onboarding and calibration
procedures in setup. Workspace formats and native plugin snapshots are unchanged.

- [x] Move registration, unregister, template discovery and provisioning assets to core.
- [x] Reunite device Setup/Profile/Use guides and move setup-device into core.
- [x] Rename the shared profile writer and permission to profile_write in core.
- [x] Expose descriptive readiness in core context without calibration procedures.
- [x] Keep setup's onboarding, calibration tools, routines, evidence and skills.
- [x] Update ownership instructions, API migration and SEPARATION.md.
- [x] Move device regressions to core and validate focused tests and typecheck.
- [x] Validate core-only installed registration, guide overrides and lifecycle cancellation.
- [x] Run full core, setup and standalone suites and package all three artifacts.
- [x] Review final diff, instructions and packaged contents.

Validation passed on Node 22.19: typecheck, 127 core tests, 7 setup tests and
69 standalone tests (203 total). Final focused checks also passed after review.
The final build and three-package packing passed. Artifacts and verified SHA256SUMS
are in /tmp/kinex-device-ownership-release. Checks also covered packed ownership,
Python syntax, guide sections, guidance JSON, Markdown links and diff whitespace.
Tests use mock devices and temporary Python drivers; physical hardware and paid
models are outside these checks. Native plugin adoption is separate work.

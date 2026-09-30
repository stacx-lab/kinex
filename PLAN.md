# Current work

`dev` is the long-lived integration branch for combined fixes. Its PR to `main`
collects those changes; individual fix branches integrate into `dev`.

- [x] Separate core profile/readiness/model foundations from setup procedures.
- [x] Add @kinex/setup for onboarding, provisioning, calibration and unregister.
- [x] Retain core-only lifecycle, perception/control tools, recording and Python.
- [x] Split setup assets from runtime Use conventions and Python helpers.
- [x] Compose both packages in standalone with shared permissions and disposal.
- [x] Extend build, packaging and CI to three aligned packages.
- [x] Document explicit composition and breaking setup API migration.
- [x] Summarize implemented package ownership and shared runtime contracts in SEPARATION.md.
- [x] Validate core-only and setup consumers, lifecycle fences and setup removal.
- [x] Complete standalone, core and setup tests, typecheck, build and packaging.

Workspace formats stay unchanged. Native plugin snapshots are updated separately
in kinex-plugins; no plugin implementation or release publication is part of this work.

Validation passed on Node 22.19: typecheck, 69 standalone tests (including PTY and
relocation), 114 core tests and 14 setup tests. The final build and three-package
packing passed; artifacts are in /tmp/kinex-setup-release with SHA256SUMS.
The installed-package test removes setup and verifies core-only lifecycle,
recording, runtime conventions and URDF model resolution. Tests use mock devices
and temporary Python drivers; no physical hardware or paid models were used.

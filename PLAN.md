# Current work

Bounded DLS restarts shared by servo and Cartesian policy actions are complete.

## Bounded IK search

- [x] Add deterministic local/broad seeds, cooperative budgets and cancellation.
- [x] Prefer the nearest verified fallback and preserve the original-seed fast path.
- [x] Add optional profile settings, diagnostics and operating guidance.
- [x] Add controlled-clock, numerical, controller and packaged-runtime coverage.
- [x] Re-run the self-contained Panda benchmark and waypoint sequences.
- [x] Complete typecheck, standalone/core/setup suites, build and local packaging.

Validation against PR #17 (`dev-setup`, `efc02b9`) on Node 22.19: typecheck,
69 standalone, 129 core and 24 setup tests,
including 14 Python IK/controller regressions and independent packed consumption;
build and local tarballs passed. Diff checks passed. Documentation links resolve
except the existing link to the unavailable sibling plugin checkout.

The self-contained Panda benchmark (Python 3.13.7, unchanged 0.1 mm / 0.001 rad
tolerances) solved 388/400 poses with bounded restarts versus 359/400 with the
single-seed DLS reference. Median latency was 2.76 ms versus 2.73 ms; p95 was
90.68 ms versus 69.00 ms. All accepted poses passed independent FK and joint-limit
checks; all ten out-of-reach controls were rejected. The 30 twenty-waypoint
sequences completed 90/90 repeated runs versus 87/90, with median chunk latency
30.99 ms versus 30.69 ms. Nearest fallback preference remains a soft choice: the
largest joint step was 0.071 rad versus 0.040 rad for the single-seed reference's
accepted prefixes. These offline results do not establish real-device task success;
wall-clock budgets make success rates sensitive to machine load.

Reproduce with `PYTHONPATH=packages/core/assets/python python3 packages/core/test/benchmark_ik.py --output /tmp/kinex-ik.json`.
Existing profiles inherit the defaults. Reload persistent drivers after upgrading;
refresh workspace-local Python overrides together before reloading. Native plugin
core snapshots remain an independent update.

Task-scoped embodiment onboarding is implemented. An agent-authored DAG selects
only prerequisites needed for the current task; incomplete calibration is never a
new execution gate.

CI and release workflows install the setup solver tests' pinned NumPy dependency;
local installation is documented. The degenerate-survey test now requires
a successful computation with degenerate geometry, so missing dependencies cannot
masquerade as a passing quality-rejection test. All 24 setup tests passed in fresh
Python 3.12 and 3.13 environments with only the declared test dependency installed.

- [x] Persist plans, task scopes, dependency validation and evidence reconciliation.
- [x] Add procedure descriptors and isolated calibration attempts.
- [x] Replace calib_plan/device_calibrate with setup_plan/calib_compute.
- [x] Refactor existing skills and add base interface, motion and posture verification.
- [x] Update workflows, public APIs, permissions, migration and documentation.
- [x] Validate synthetic solvers, task scopes, compositions, permissions and cancellation.
- [x] Run typecheck and full standalone/core/setup suites.
- [x] Finish final build, packaging and diff checks after the last descriptor refinements.

Validation on Node 22.19: 69 standalone, 127 core and 24 setup tests passed (220
total). The final setup rerun covers an operational base mode alongside an
incomplete unused mode. Checks also cover partial TCP facts, concrete dual-arm
bindings, moving torso/base attachments, stale transitive dependencies, deferred
procedure errors, solver quality gates, owned-process cancellation and relocated
package consumption/removal. Ten skills, Python syntax and local Markdown links
validated. Existing operation validation and host permissions remain intact.

Physical hardware and live simulator acceptance remain separate validation work.
Native plugin snapshots were not changed. Final build and three-package packing
passed; artifacts and SHA256SUMS are in /tmp/kinex-task-scoped-release. No packages
were published.

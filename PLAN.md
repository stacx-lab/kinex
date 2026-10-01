# Current work

Task-scoped embodiment onboarding is implemented. An agent-authored DAG selects
only prerequisites needed for the current task; incomplete calibration is never a
new execution gate.

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

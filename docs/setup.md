# Setup, calibration and ROS provisioning

## Task prerequisites and calibration evidence

Setup owns a persisted, task-scoped DAG; inspection is read-only. Completion checks
fact availability, explicit values, evidence and completed prerequisites, without
receipt-hash invalidation on content/definition edits. Calibration attempts and
solver results retain separate fingerprint checks. Settling requires fresh declared
velocity feedback and never advances simulation time. A timeout after a read saves
`settled:false`; FK and archival still honor caller cancellation. RGBD archival
copies both streams before appending. Profile writes are validated; unrelated
calibration never gates all operations. See the [setup evidence contracts](../packages/setup/README.md#plan-and-evidence-contracts).

## ROS provisioning

Setup owns ROS implementation, `kinex_ros` and dependency checks, targeting Jazzy
on Ubuntu 24.04 with Python 3.12. Core's `kind: ros` is inert metadata. Onboarding
and registration route through `onboard-ros2`, preferring installed packages, then
apt binaries; source builds/direct SDKs need an evidenced reason or user choice.
Preserve working integrations unless replacement is requested. Detection never
selects an undeclared distribution. Domain/namespace and CameraInfo configuration
remain bundle/driver facts outside the core schema.

Provisioning requires explicit absolute core/setup Python roots. It stages and
validates syntax and driver/URDF artifacts before renaming to
`ros/generations/<id>`. Normal `profile_write` selects entry/interpreter after
unload; provisioning never edits the selected profile. Failed candidates preserve
selected files, satellites pin parent generations, and destinations are checked
and locked before writing. Runtime inventories and declared source inputs affect
the digest; missing inputs fail preparation.

Generations deploy runtime helpers, excluding provisioning/installer modules.
Direct provisioning imports are rejected; custom runtime dependencies need offline
validation, and static checks cannot prove dynamic imports. Wrappers source the
declared ROS installation/overlay and use generation-local ROS helpers plus core
Python. Provisioned devices survive setup removal. Shared host packages/overlays
are not rolled back; failed legacy migration stays unloaded and repairs forward.

Apt checks are read-only. Installation uses the host's permission-checked shell;
sudo-required commands go to the user with the target host, then dependencies are
rechecked. `--install` covers pip/Git preparation and source builds only; missing
apt prerequisites block them. See [bundle contracts](../packages/setup/assets/builtin/skill/onboard-ros2/references/bundles.md).

See [project overview](overview.md) for the core/setup boundary and the
[setup API](../packages/setup/README.md) for workflows and composition.

[Design index](README.md)

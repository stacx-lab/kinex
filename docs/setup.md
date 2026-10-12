# Setup, calibration and ROS integration

## Task prerequisites and calibration evidence

Setup owns a persisted, task-scoped DAG; inspection is read-only. Completion checks
fact availability, explicit values, evidence and completed prerequisites, without
receipt-hash invalidation on content/definition edits. Calibration attempts and
solver results retain separate fingerprint checks. Calibration samplers' settling
checks require fresh declared velocity feedback and never advance simulation
time. A timeout after a read saves `settled:false`; FK and archival still honor
caller cancellation. Camera sampling must request `args: {output: "file"}` to
archive image files; RGBD archival copies both streams before appending. Profile
writes are validated; unrelated calibration never gates all operations. See the
[setup evidence contracts](../packages/setup/README.md#plan-and-evidence-contracts).

For calibration motion, blocking `servo` already waits its planned duration on a
loaded world clock. Check fresh measured feedback before sampling; if simulation
needs more time, advance it explicitly before invoking the sampler. General
feedback loops use [Python execution with `exec`](tools-and-skills.md#python-execution-with-exec);
the sampler's own settling and evidence checks remain part of setup.

## ROS integration

Setup owns ROS configuration and the `kinex_ros` adapters. Match the interpreter
to the selected ROS distribution. Core's `kind: ros` is inert metadata. Onboarding
and registration route through `onboard-ros2`, preferring installed packages, then
apt binaries; source builds/direct SDKs need an evidenced reason or user choice.
Preserve working integrations unless replacement is requested. Domain/namespace
and CameraInfo configuration live in the device-root `profile_ros.yaml`, outside the core schema.

Device drivers and optional ROS configuration files live directly in the device
directory. Use `profile_write` to register their actual entry/interpreter paths.
Unload through core before replacing a device's runtime files, then validate and
reload through the normal lifecycle. ROS drivers do not create auxiliary setup-state
files. Profile fields are passed directly to the profile tool; interface observations are returned to the caller rather than saved as reports.

ROS configuration loading and adapters remain independent library functions.
The agent installs dependencies and writes startup scripts directly. Wrappers source
the selected ROS installation and overlay in a separate process. Drivers may carry the ROS helpers they require so
that removing setup does not break operation. Shared host packages/overlays are not
rolled back.

Dependency installation uses the host's permission-checked shell;
sudo-required commands go to the user with the target host. See the
[ROS integration skill](../packages/setup/assets/builtin/skill/onboard-ros2/SKILL.md).

See [project overview](overview.md) for the core/setup boundary and the
[setup API](../packages/setup/README.md) for workflows and composition.

[Design index](README.md)

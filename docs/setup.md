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

For calibration motion, explicitly wait on the loaded world clock and check
fresh measured feedback before sampling; if simulation needs more time, advance
it explicitly before invoking the sampler. General
feedback loops use [Python execution with `exec`](tools-and-skills.md#python-execution-with-exec);
the sampler's own settling and evidence checks remain part of setup.

## ROS integration

Core owns ROS node supervision, communication helpers and interfaces. Setup owns
onboarding and calibration procedures. New integrations declare explicit
`runtime` and `operations` fields in device profiles; see
[ROS communication](communication.md). Registration uses `onboard-ros2`, preferring
compatible installed packages and binaries before source builds.

Device nodes and optional local sources live directly in the device directory.
Use `profile_write` to register node factories; default nodes inherit Kinex
Python. Declare interpreter/overlay overrides only for separate device SDKs. Unload
before replacing runtime definitions, validate, then explicitly reload. Existing
external stacks are borrowed; Kinex unload releases only its owned nodes.
Interface checks return observations to the caller instead of writing setup reports.

Core owns async protocol helpers and the world-clock client. Legacy direct
hardware adapters and profile_ros.yaml execution are unsupported. Declare native
ROS operations and node factories instead. ROS activation stays within owned
subprocesses; shared host packages and overlays are never rolled back on unload.

Dependency installation uses the host's permission-checked shell;
sudo-required commands go to the user with the target host. See the
[ROS integration skill](../packages/setup/assets/builtin/skill/onboard-ros2/SKILL.md).

See [project overview](overview.md) for the core/setup boundary and the
[setup API](../packages/setup/README.md) for workflows and composition.

[Design index](README.md)

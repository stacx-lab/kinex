# Setup, calibration and ROS integration

## Task prerequisites and calibration evidence

Setup owns a persisted, task-scoped DAG; inspection is read-only. Completion checks
fact availability, explicit values, evidence and completed prerequisites; content
edits alone do not invalidate it. Calibration attempts and solver results keep
their own fingerprint checks. Sampler settling requires fresh measured velocities
and never advances simulation time; a locomotion device settles on the odometry its
`runtime.observation` names. A timeout after a read saves `settled:false`; FK and
archival still honor caller cancellation. Without a configured observation, camera
samples read the native `image` topic and, for RGBD, the equally stamped `depth`;
both files are archived before the sample is appended. Profile writes are
validated; unrelated calibration never gates all operations. See the
[setup evidence contracts](../packages/setup/README.md#plan-and-evidence-contracts).

For calibration motion, explicitly wait through the loaded world's declared `wait`
and check fresh measured feedback before sampling; if simulation needs more time,
advance it explicitly before invoking the sampler. General
feedback loops use [Python execution with `exec`](tools-and-skills.md#python-execution-with-exec);
the sampler's own settling and evidence checks remain part of setup.

## ROS integration

Core owns ROS node supervision, communication helpers and interfaces. Setup owns
onboarding and calibration procedures. New integrations declare explicit
`runtime` and `operations` fields in device profiles; see
[ROS communication](communication.md). Registration uses core's `setup-device`,
preferring compatible installed packages and binaries before source builds.

Simulator workspaces come from [rosbridge](https://github.com/stacx-lab/rosbridge):
`rosbridge setup <robot> --directory DIR --domain-id N` exports unloaded profiles
that borrow the simulator's endpoints and carry their calibration. Load them after
`rosbridge launch <task> --execution-mode stepped|realtime --domain-id N` starts
the graph on the same domain.

Device nodes and optional local sources live in `.kinex/devices/<name>/`; shared
code may use `.kinex/lib/`. Use `profile_write` to register node factories;
default nodes inherit Kinex Python. Declare interpreter/overlay overrides only for
separate device SDKs. Unload before replacing runtime definitions, validate, then
explicitly reload. Existing external stacks are borrowed; Kinex unload releases
only its owned nodes. Verification loads the device within the authorized task
scope, inspects readiness and exercises the declared operations, input rejection,
stop and teardown, returning observations to the caller.

Core owns async protocol helpers and the world-clock client. ROS activation stays
within owned subprocesses; shared host packages and overlays are never rolled back on unload.

Dependency installation uses the host's permission-checked shell. For ROS,
`.kinex/kinex.json` selects `python.provider: "ros-jazzy"` and interface sources;
the first approved exec prepares Kinex Python, which is never activated in
ordinary shells. See the
[setup-device skill](../packages/core/assets/builtin/skill/setup-device/SKILL.md).

See [project overview](overview.md) for the core/setup boundary and the
[setup API](../packages/setup/README.md) for workflows and composition.

[Design index](README.md)

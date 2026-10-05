---
name: verify-base-interface
description: Establish missing base control and feedback conventions for a task, without requiring a full mobility calibration.
---

# Verify base interface

Bind `base` to a velocity endpoint. Read the core velocity guide and actual SDK
or simulator metadata. Reuse existing verified conventions. Select only facts
needed by the task: body/heading command frame, mode, axis signs, units, feedback
velocity frames, body measurements, stop scope, or moving attachment frames. Use the world
device for time and waiting; do not add a clock-type label to feedback.

Archive the source of each fact. Preserve normalized command units where the
interface declares them; a normalized value does not imply metres per second.
Velocity bases are unlocalized roots and expose no global pose. Use explicit
frame estimates when needed; do not create a fixed world mount. Verify the
reference for body height and parent-relative local frame measurements. A wheeled base need not expose
posture; quadruped and humanoid modes can expose it without raw leg-joint control.

For live verification prepare the driver, load explicitly, then inspect fresh
read/status data. Interface inspection itself never commands motion. If a fact
requires movement, use a narrowly scoped motion/posture procedure. Fix proven
conversion or frame-mapping errors in the driver, reload through core lifecycle,
and verify the corrected output. Do not silently tune the controller.

Archive relevant exact assertions in a measurements file, naming only required
checks. `calib_compute operation:verify-base` evaluates those assertions; its tool
description defines the evidence format. Persist verified profile facts and record
only the resolved plan node. Do not turn all possible interface checks into a
mandatory prerequisite for every task.

See [procedure.json](procedure.json) for roles and computations.

---
name: calibrate-tcp-offset
description: Measure flange-to-tool-tip translation by pivot touches when a task needs a TCP; orientation remains a separate fact.
---

# Calibrate tcp offset

Bind `target` to a gripper whose canonical frame is its TCP, and `arm` to its
actual parent arm. If TCP is a named local frame, use an explicit custom procedure
for that field instead of overwriting the device mount.

Prefer verified controller TCP settings or a matching tool datasheet. Archive the
source with provenance rather than repeating measurement. Otherwise require
measured attachment-frame poses; driver frame conversion has already removed any
reported TCP offset, so do not subtract it twice.

Prefer hand-guiding a rigid pointed tool to one fixed reference point. Two repeated
touches from the same orientation should agree within about 3 mm; otherwise fix
tool/fixture movement first. Contact confirmation comes from the operator.
Never command motion while touching. When powered approaches are needed, retract
before reorientation and approach in user-confirmed approximately 5 mm steps at
an appropriate low speed. Wait for execution and verify measured arrival.

Capture with `calib_sample` into one attempt, using settling only when supported
by measured velocity feedback. Collect at least 4 orientations separated by roughly
20 degrees; 6–8 are typical. From sample 4 onward run `calib_compute operation:fit-tcp`
with `samples` and the actual attachment `frame`, reusing the run ID. Stop collecting
when quality and diversity satisfy the task.

Mean residual < 5 mm is good, 5–10 mm needs review against the task's accuracy, and
> 10 mm fails. Archive exclusions and original readings rather than silently
removing outliers. Persist accepted translation only. Pivoting does not measure
orientation: preserve a verified rotation, or leave it unknown. A task requiring
translation alone may proceed while a broader extrinsics request stays open.

See [procedure.json](procedure.json) for machine-readable roles and field coverage.

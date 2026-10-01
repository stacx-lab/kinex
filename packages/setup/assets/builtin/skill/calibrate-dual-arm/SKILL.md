---
name: calibrate-dual-arm
description: Measure the relative transform of two arms using their calibrated TCPs when a task needs cross-arm coordinates.
---

# Calibrate dual arm

Bind `anchor`, `second`, `anchor_tcp` and `second_tcp` to the actual two arms and
their own tools. Require each TCP translation/orientation and participating arms'
measured pose/control capabilities. Calibration of an unrelated gripper is irrelevant.
The second arm's mount is the output. Neither arm needs a surveyed world mount.

Collect shared fixed fiducials reachable by both TCPs, recording each touched
point in that arm's BASE frame. Move one arm at a time; park the other clear.
Use supported low speed and user-confirmed approximately 5 mm contact approaches.
Never move while touching; retract before switching arms. Keep the arm-base
relationship fixed during measurement, including mobile-base/torso posture.

Archive `{anchor_points_m:[[...]],second_points_m:[[...]]}` in matching order.
Use at least 4 well-spread noncoplanar points and preserve repeat measurements.
Run `calib_compute operation:fit-dual` with `points`. Require RMS <= 2 mm,
maximum residual <= 4 mm, nondegenerate geometry and proper rotation.

The proposed mount is second-base-in-anchor-base. Apply only when that parent
relationship is intended and does not introduce a frame cycle; otherwise explicitly
compose into the chosen parent with established transforms. Verify using
`relative_pose` and a held-out observation when available. Archive evidence and
stop when the task's cross-arm requirement is satisfied. Single-arm tasks do not
require this procedure.

See [procedure.json](procedure.json) for machine-readable roles and field coverage.

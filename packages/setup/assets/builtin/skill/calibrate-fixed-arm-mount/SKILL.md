---
name: calibrate-fixed-arm-mount
description: Survey an arm base relative to its rigid parent, including a mobile base or moving torso attachment frame.
---

# Calibrate fixed arm mount

Bind `target` to the joint device and `parent` to the actual parent device.
The fitted relationship is fixed between these frames even if the whole robot
moves. World is optional. If frames are explicitly defined to coincide, archive
that definition and record identity with appropriate provenance; missing facts
never imply identity.

Prefer documented geometry or non-motion survey. Collect matching points in the
arm base and the declared parent frame, in metres and the same order. Use measured
fixtures, CAD with traceable geometry, a tracker or calibrated touch probing;
uncalibrated images do not establish parent coordinates.

For touch probing, add dependencies on the particular arm's control/feedback and
TCP. Approach slowly in user-confirmed approximately 5 mm steps; never command
motion while touching. A non-motion survey does not require loading the arm.

Archive `{arm_points_m:[[...]],parent_points_m:[[...]]}`. Use at least 4 well-spread,
noncoplanar points. Run `calib_compute operation:fit-mount` with `points` and the
actual `parent_frame`. The solver requires nondegenerate geometry, RMS <= 2 mm,
maximum residual <= 4 mm, and a proper rotation.

Persist the accepted parent<-arm transform directly. Keep raw pairs and residuals
in evidence. On mobile robots verify the measured reference relationship stayed
consistent; do not replace measured base pose with a world-fixed mount.
A local arm task may not need this survey at all.

See [procedure.json](procedure.json) for machine-readable roles and field coverage.

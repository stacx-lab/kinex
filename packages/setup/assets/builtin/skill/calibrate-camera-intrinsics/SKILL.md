---
name: calibrate-camera-intrinsics
description: Measure color-camera projection and distortion when the task needs calibrated image geometry; RGB-D depth facts remain separate.
---

# Calibrate camera intrinsics

Use for color projection/distortion on RGB or RGB-D devices. Viewing images alone
does not require this procedure. Reuse factory calibration matching the active
resolution, crop, focus and rectification before collecting new evidence.

Bind `target` to the camera. Record the stream configuration in the run's evidence.
The camera must be loaded and responsive for collection. Use a flat ChArUco or
checkerboard with measured printed square dimensions. `scripts/generate_board.py`
(exec `file` under this skill's base directory, options in `argv`) can generate a
target; a printout's nominal dimensions are not measurements.

Collect sharp views across image corners, distance and tilt. Start with 10 usable
frames and add views only for insufficient coverage or quality; 15–25 often suffice.
`run.sample` the camera for each view, then solve with
`lib.calibration.camera.intrinsics` and the measured `square_mm`. Declare marker
dimensions/dictionary for ChArUco and corner counts for checkerboards.

At least 10 frames and RMS <= 1 px are required. RMS < 0.5 px is good; 0.5–1 px
or incomplete image coverage requires checking the task's accuracy needs. Above
1 px, diagnose blur, wrong target geometry or poor coverage before recollecting.

On a first calibration choose the `model`; do not fit raw fisheye images with
Brown-Conrady. Views the fisheye solver finds ill-conditioned are rejected and the
rest re-solved.

For stereo RGB, calibrate each eye in its own solve with `eye`; the result proposes
that eye's `left` or `right` fields. With the board held still at each capture, the
same run's paired views also measure the eye-to-eye transform (see
calibrate-camera-extrinsics).

Apply accepted color fields with `profile_write`, retaining active stream formats.
Keep RGB-D depth scale/registration/range from the SDK; the board does not measure
them. Evidence includes RMS, coverage and source images. Stop when the current
task's required camera facts are established.

See [procedure.json](procedure.json) for machine-readable roles and field coverage.

Reuse factory calibration before measuring. SDK calibration snapshots are optional. This procedure produces OpenCV parameters for a node adapter; reload the node after applying them.

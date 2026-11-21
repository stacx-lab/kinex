---
name: calibrate-camera-extrinsics
description: Measure a camera mount from robot poses and board observations when a task needs camera-to-robot coordinates.
---

# Calibrate camera extrinsics

Bind `target` to the camera and `arm` to the observing arm. Require the camera's
usable color geometry (services or explicit undistorted pinhole intrinsics)
and the selected arm's model and measured attachment
frame. Bind frame-specific prerequisites in the plan; do not require world
localization for an arm-local measurement. RGB-D uses the COLOR optical frame.

Choose `eye_in_hand` for a wrist camera observing a fixed board, or `eye_to_hand`
for a camera fixed relative to the arm base and a board carried by the arm.
Use known/measured board geometry. On mobile robots the relationship assumed fixed
by the solver must actually remain fixed during collection. Base/torso motion that
changes it invalidates those pairs; holding commanded zero is not proof of rest.

Verify participating devices answer before physical preparation. Plan motion with
`lib.motion.trajectory` using `fraction <= 0.15`, submit through the device's
declared command operation, wait on the world clock and verify measured arrival.
Record the named attachment frame, without applying TCP offset.
At each pose, `run.sample` the arm with `frame`, then the camera; a retake
replaces the previous capture. Sequential captures are not claimed to be
synchronized. Use at least 5 diverse poses; 10–15 are typical. Prefer rotations
separated by roughly 20 degrees.

`lib.calibration.camera.observations` turns the run's captures into board views with
the measured square size; keep its rejections and geometry calibration IDs in
evidence. Pass `eye` to observe one stereo eye. Solve with
`lib.calibration.camera.extrinsics` for the mode and attachment `frame`. Require
rotation residual <= 2 degrees and translation residual <= 10 mm. Add diverse pairs
only when quality requires them.

For a rigid stereo pair, frames chain robot -> `base` -> reference eye -> other eye;
the reference eye is the one whose parent is `<camera>:base`. Declare plan outputs for
`base` and both eyes, validate the full chain with poses the solve did not use, and
apply each accepted proposal before the next solve.

Establish the eye-to-eye transform first. Keep a factory transform recorded from the
SDK. Otherwise use `camera.eye_to_eye`, which needs no arm: paired views of a still
board, such as intrinsics captures observed without `arm`, measure it without hand-eye
error. Then `camera.stereo_extrinsics` with `eye_to_eye="keep"` lets both eyes
constrain the mount; `eye_to_eye="solve"` measures both together and is only for when
no eye-to-eye transform exists. Require RMS angular residual <= 0.5 degrees, inspect
per-view residuals, and pass the camera's `nominal_baseline_m` when known.

When the eyes rarely see the board together, observe and solve each eye with `eye`.
A factory eye-to-eye transform lets either eye place `base`.

The proposed mount is camera-in-parent; do not invert it. Eye-in-hand uses the
arm attachment frame; eye-to-hand uses the arm base. A world mount requires an
explicitly established transform. Persist accepted fields, retain residuals in
evidence, and return to the task once its required transform is available.

See [procedure.json](procedure.json) for machine-readable roles and field coverage.


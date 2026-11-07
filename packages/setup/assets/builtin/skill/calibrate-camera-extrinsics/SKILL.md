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
`kinex.helpers.trajectory` using `fraction <= 0.15`, submit through the device's
declared command operation, wait on the world clock and verify measured arrival.
Record the named attachment frame, without applying TCP offset.
At each pose, take `calib_sample` of the arm with `frame`, then of the camera; a
retake replaces the previous capture. Sequential captures are not claimed to be
synchronized. Use at least 5 diverse poses; 10–15 are typical. Prefer rotations
separated by roughly 20 degrees.

Turn the captures into observations with one exec of `scripts/board_observations.py`
(pass its absolute path under this skill's base directory as `file`) with argv
`--samples .kinex/calib/<run>/samples.json --camera <camera> --arm <arm> --frame <frame>
--output <file> --square-mm <measured>` plus board options. It pairs each settled arm
pose with the camera capture after it, detects the board, unprojects corners through
the camera's active geometry (any lens model), and reports rejected samples and the
geometry calibration IDs; keep them in evidence. Add `--eye` to observe one stereo eye.

Run `calib_compute operation:camera-extrinsics` with the run ID, observations file,
mode and attachment `frame`. Require rotation residual <= 2 degrees and translation
residual <= 10 mm. Add diverse pairs only when quality requires them.

For a rigid stereo pair, frames chain robot -> `base` -> reference eye -> other eye;
the reference eye is the one whose parent is `<camera>:base`. Declare plan outputs for
`base` and both eyes, validate the full chain with poses the solve did not use, and
apply each accepted proposal before the next solve.

Establish the eye-to-eye transform first. Keep a factory transform recorded from the
SDK. Otherwise run `calib_compute operation:camera-eye-to-eye`, which needs no arm:
paired views of a still board, such as intrinsics captures, measure it without
hand-eye error. Then run `operation:camera-stereo-extrinsics` with `eye_to_eye:keep`,
mode and `frame`, so both eyes constrain the mount. Use `eye_to_eye:solve` only when
no eye-to-eye transform exists; it measures both together. Stereo observations keep
views where both eyes see the board; omit `--arm` and `--frame` for the eye-to-eye
solve. Require RMS
angular residual <= 0.5 degrees, inspect per-view residuals, and pass the camera's
`nominal_baseline_m` when known.

When the eyes rarely see the board together, solve each eye with `--eye` observations
and `operation:camera-extrinsics` with `eye`. Proposals keep every known edge: a solve
places `base` when the eye's chain to `base` is known (a factory eye-to-eye transform
counts), and otherwise places the other eye relative to a measured reference.

The proposed mount is camera-in-parent; do not invert it. Eye-in-hand uses the
arm attachment frame; eye-to-hand uses the arm base. A world mount requires an
explicitly established transform. Persist accepted fields, retain residuals in
evidence, and return to the task once its required transform is available.

If the user explicitly keeps a result beyond these limits, follow the
`calib_compute` acceptance rules.

See [procedure.json](procedure.json) for machine-readable roles and field coverage.


---
name: calibrate-camera-extrinsics
description: Measure a camera mount from robot poses and board observations when a task needs camera-to-robot coordinates.
---

# Calibrate camera extrinsics

Bind `target` to the camera and `arm` to the observing arm. Require the camera's
color projection/distortion and the selected arm's model and measured attachment
frame. Bind frame-specific prerequisites in the plan; do not require world
localization for an arm-local measurement. RGB-D uses the COLOR optical frame.

Choose `eye_in_hand` for a wrist camera observing a fixed board, or `eye_to_hand`
for a camera fixed relative to the arm base and a board carried by the arm.
Use known/measured board geometry. On mobile robots the relationship assumed fixed
by the solver must actually remain fixed during collection. Base/torso motion that
changes it invalidates those pairs; holding commanded zero is not proof of rest.

Verify participating devices answer before physical preparation. Move with
`servo speedFraction <= 0.15`, allow execution with `world.wait`, and verify
measured arrival. Record the named attachment frame, without applying TCP offset.
Use `calib_sample` for robot evidence and camera artifacts; retain both sample IDs
and timestamps. Sequential captures are not claimed to be synchronized.

`scripts/detect_board.py` detects ChArUco/checkerboard observations. Archive selected
pairs as `[{frame_pose:[x,y,z,qx,qy,qz,qw],rvec:[...],tvec:[...]}]` outside the
sampler-owned samples.json. Exclude failed detections with reasons. Use at least
5 diverse pairs; 10–15 are typical. Prefer rotations separated by roughly 20 degrees.

Run `calib_compute operation:camera-extrinsics` with the run ID, pairs file, mode,
and attachment `frame`. Require rotation residual <= 2 degrees and translation
residual <= 10 mm. Add diverse pairs only when quality requires them.

The proposed mount is camera-in-parent; do not invert it. Eye-in-hand uses the
arm attachment frame; eye-to-hand uses the arm base. A world mount requires an
explicitly established transform. Persist accepted fields, retain residuals in
evidence, and return to the task once its required transform is available.

During setup, if the user explicitly asks to keep a result despite exceeding the
error limits above, honor the request; do not refuse or force recollection solely
because of those limits. When requested, persist the computed fields with
`profile_write`, using archived solver data if `proposedChanges` is empty. Record
errors, limits and the user decision in evidence; retain the original quality
assessment and do not mark a failed-quality node done. Preserve frame conventions,
profile validation and host permissions; never invent missing computed values.

See [procedure.json](procedure.json) for machine-readable roles and field coverage.

---
name: calibrate-fixed-arm-mount
description: Locate a fixed joint device in a declared parent frame using surveyed 3D point pairs.
resolves: extrinsics:joint
---

# Fixed joint mount calibration

Fills `extrinsics:<arm>`: the arm base in its fixed parent frame, fitted as
`p_parent = R · p_arm + t` from corresponding 3D fiducials — exactly the profile's
`mount` convention, so the fit is written as-is. Script: `scripts/fit_mount.py`
(numpy only). Scratch: `.kinex/calib/calibrate-fixed-arm-mount/`.

In the examples, `<core-python>` is `python.executable` from context; set `PYTHONPATH` to `python.library` for the command.
Scratch paths are workspace-relative; pass absolute evidence paths to scripts.

## Check the frame definition

If the canonical device frame and declared parent frame are explicitly defined to
coincide, record identity with source:user and retain that definition in evidence.
Otherwise measure their transform using the procedure below. A missing mount is
not an identity transform.

## 0. Preconditions

- The parent frame is physically defined and reproducible (for example `world:fixture`).
- `"<core-python>" -c "import numpy"`.
- ≥ 4 rigid, well-spaced, non-coplanar fiducials preferred (3 non-collinear is the minimum),
  each measured in BOTH frames, metres, same order. Arm-frame coordinates: the robot/CAD
  drawing, or touch-probing with a calibrated TCP and reading the state. Parent-frame
  coordinates: a surveyed jig, CMM, tracker or metrology fixture — never uncalibrated images.
- Prefer a non-motion survey. If the arm touches fiducials: driver verified, TCP calibrated,
  approach in ~5 mm user-confirmed steps with a supported low-speed setting, never command motion
  while touching a point.

Use an existing device or named world frame as the parent (for example,
parent=world, parent_frame=fixture).

## 1. Collect correspondences

`points.json` in the scratch directory, points spanning all three axes (archive repeats,
never average them silently):

```json
{
  "arm_points_m": [[x,y,z], [x,y,z], [x,y,z], [x,y,z]],
  "parent_points_m": [[x,y,z], [x,y,z], [x,y,z], [x,y,z]]
}
```

## 2. Solve

```bash
"<core-python>" scripts/fit_mount.py --points /absolute/path/points.json
```

One JSON object: `pose`, per-point residuals, rms/max, point count, singular values,
degeneracy check, `quality_pass`.

## 3. Quality gate

Persist only when `quality_pass` is true (≥ 4 points, non-degenerate geometry, rms ≤ 2 mm,
max ≤ 4 mm, proper rotation). Otherwise re-survey wider-spread points.

## 4. Persist and verify

Clear needs_calibration explicitly with null only when the complete item is resolved.

```text
calib_write kind=device data={
  "name": "<arm>",
  "extrinsics": {"source": "calibration", "method": "survey",
    "mount": {"parent": "<parent-device>", "parent_frame": "<parent-frame>",
              "translation_m": [x,y,z],
              "rotation_xyzw": [qx,qy,qz,qw]}}}
```

Archive `points.json` and the solver JSON. Re-run `calib_plan` and confirm `extrinsics:<arm>`
is done; on failure persist nothing and update the marker (`calib_write kind=needed`).

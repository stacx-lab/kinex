---
name: calibrate-dual-arm
description: Measure the transform between two joint bases directly, by touching shared fiducials with both calibrated TCPs — one measured edge for bi-manual accuracy instead of two composed surveys.
resolves: extrinsics:joint
requires: access:joint,extrinsics:gripper
---

# Dual-arm cross calibration

Two arms surveyed independently against a shared parent frame compose their relative pose through the
tree's common ancestor — two survey errors stack exactly where handover and shared grasps
need accuracy. This skill measures `T_anchorbase_secondbase` DIRECTLY: both TCPs touch the
same points, and a rigid registration between the two base-frame point sets is the arm-to-arm
edge. Script: `scripts/fit_dual.py` (numpy only). Scratch: `.kinex/calib/calibrate-dual-arm/`.

In the examples, `<core-python>` is `python.executable` from context; set `PYTHONPATH` to `python.library` for the command.
Scratch paths are workspace-relative; pass absolute evidence paths to scripts.

## 0. Preconditions

- Both drivers verified (`device <arm>` read succeeds for each) and BOTH TCPs calibrated
  (`extrinsics:<gripper>` done) — points are read through the TCPs, so TCP error becomes
  mount error.
- ANCHOR arm = the one whose existing mount you trust most; the SECOND arm's mount is what
  this skill rewrites. With no trusted body mount yet it still works — the second arm mounts
  on the anchor (step 3).
- ≥ 4 rigid, well-spaced, non-coplanar fiducials REACHABLE BY BOTH arms (3 non-collinear
  minimum). `"<core-python>" -c "import numpy"`.
- ONE ARM MOVES AT A TIME: park the idle arm clear of the shared workspace first. Approach a
  point in ~5 mm user-confirmed steps with a supported low-speed setting; never command motion while
  touching.

## 1. Collect correspondences

Per fiducial: touch it with the anchor TCP, record the TCP position in the ANCHOR base frame
(`device <anchor-arm>` read / `fk`, TCP offset applied), retract; repeat with the second arm
in ITS base frame. Same points, same order, spanning all three axes; archive repeats rather
than averaging silently. `points.json` in the scratch directory:

```json
{
  "anchor_points_m": [[x,y,z], [x,y,z], [x,y,z], [x,y,z]],
  "second_points_m": [[x,y,z], [x,y,z], [x,y,z], [x,y,z]]
}
```

## 2. Solve

```bash
"<core-python>" scripts/fit_dual.py --points /absolute/path/points.json
```

Returns `pose` = `T_anchorbase_secondbase` (second base in the anchor's base frame,
quaternion xyzw — the `mount` convention with the anchor as parent), per-point
residuals, rms/max, degeneracy check, `quality_pass`.

## 3. Quality gate, persist, verify

Clear needs_calibration with null after the complete section is resolved.
Persist only when `quality_pass` is true (≥ 4 points, non-degenerate, rms ≤ 2 mm,
max ≤ 4 mm, proper rotation); otherwise re-survey wider-spread points.

**Default — the second arm mounts on the anchor's base** (the frame graph resolves
canonical joint device frames; every relative pose between the arms rides this one edge):

```text
calib_write kind=device data={
  "name": "<second-arm>",
  "extrinsics": {"source": "calibration", "method": "survey",
    "mount": {"parent": "<anchor-arm>", "parent_frame": "<anchor-arm>",
              "translation_m": [x,y,z],
              "rotation_xyzw": [qx,qy,qz,qw]}}}
```

Verify with the `relative_pose` tool (second base in anchor base) — it must reproduce the
fit. Archive `points.json` and the solver JSON; re-run `calib_plan` and confirm
`extrinsics:<second-arm>` is done; on failure persist nothing and update the marker
(`calib_write kind=needed`).

---
name: calibrate-camera-extrinsics
description: Locate a camera relative to the robot — wrist-mounted (eye-in-hand) or fixed (eye-to-hand) — by hand-eye calibration from paired robot poses and board detections. Needs the camera's intrinsics.
resolves: extrinsics:rgb,extrinsics:rgbd
---

# Camera extrinsics calibration (hand-eye, both variants)

Fills `extrinsics:<camera>` — the mount of an rgb/rgbd camera (for rgbd: the COLOR optical
frame; the procedure runs on the color stream). One pure-numpy Tsai–Lenz solver covers:
- **eye_in_hand** — camera on the arm, board FIXED in the workspace → T_flange_camera.
- **eye_to_hand** — camera fixed, board held by / attached to the gripper (the board→flange
  offset need not be measured; the solver absorbs it) → T_base_camera.

Choose the variant from the recorded mount; ask only if the physical arrangement is unclear.
Use servo with speedFraction ≤ 0.15 for the loop. Anyone steadying the board keeps hands clear. Scratch: `.kinex/calib/calibrate-camera-extrinsics/`.

In the examples, `<core-python>` is `python.executable` from context; set `PYTHONPATH` to `python.library` for the command.
Scratch paths are workspace-relative; pass absolute evidence paths to scripts.

## 0. Preconditions

- `intrinsics:<camera>` done — read intrinsics.color from the device profile.
- The selected joint device is loaded and its read succeeds before physical prep.
  It declares a moving attachment frame in intrinsics.frames. The examples use
  flange; substitute the actual frame in readings and solver arguments.
  Pose goals require the device’s declared IK; joint goals do not.
- Use Kinex core Python (`"<core-python>"`); verify `import cv2, numpy, yaml`
  and `cv2.aruco`. Keep one OpenCV distribution in that environment.
- A board of KNOWN geometry. No factory board? Do not block: print a ChArUco/checkerboard
  and have the user measure one square (±0.5 mm is plenty) — a measured print IS a measured
  board; an on-site ArUco/AprilTag setup with a known tag size works too.

## 1. Collect 10–15 pose pairs

Choose reachable, collision-free targets from the joint model and observed scene,
with large rotation diversity. Use measured world geometry only when available;
consecutive orientations ≥ ~20° apart: hand-eye degenerates with pure translations. Per pose:
1. announce → `servo` with a pose in `<arm>`, or a model-ordered joint target;
2. `calib_sample deviceID=<arm> routine=calibrate-camera-extrinsics settle={...} note="pose N"`
   — the flange pose [x,y,z,qx,qy,qz,qw] lands in samples.json as `data.frame_poses.flange`;
3. read the camera → frame path;
4. `"<core-python>" scripts/detect_board.py --image PATH --profile .kinex/devices/<camera>/profile.yaml \
      --board charuco --squares-x 7 --squares-y 5 \
      --square-mm <MEASURED> --marker-mm <MEASURED_MARKER> --dict DICT_4X4_50`
   → `{"ok": true, "rvec": [...], "tvec": [...], "reproj_px": 0.6, "corners": 31}`;
   on `ok: false` (board not visible / too few corners) skip the pose — do not force it.

Accumulate kept pairs in `pairs.json` (write tool — NOT `samples.json`, which calib_sample owns):

    [{"frame_pose": [x,y,z,qx,qy,qz,qw], "rvec": [...], "tvec": [...]}, ...]

## 2. Solve

    "<core-python>" scripts/solve_extrinsics.py --device <arm> --frame flange --mode eye_in_hand|eye_to_hand --samples pairs.json

    → {"ok": true, "translation_m": [x,y,z], "rotation_xyzw": [qx,qy,qz,qw], "parent_frame": "flange"|"<arm>",
       "method": "Tsai", "residual_rot_deg": 0.8, "residual_trans_mm": 4.1, "pairs_used": 12}

`{"ok": false, "error": "insufficient rotation diversity"}` → more poses with bigger
orientation changes.

## 3. Quality gate

residual_rot_deg ≤ 2 and residual_trans_mm ≤ 10 → good. Above either: collect ~5 more
diverse pairs and re-solve; if it still does not converge, suspect a wrong pose convention
(the TCP offset must NOT be applied to the recorded poses) or a moving board.

## 4. Persist and verify

Clear needs_calibration explicitly with null only when the complete item is resolved.

Persist the solver's translation_m and rotation_xyzw directly under
extrinsics.mount, together with parent and parent_frame. For eye-in-hand use
the arm's flange; eye-to-hand solves camera-in-arm-base, so use the arm device
and its canonical frame (parent_frame is the device name). Use world only after
explicitly composing that reference transform.
Set extrinsics.source: calibration, method: hand_eye, and calibrated_at to
an ISO UTC timestamp. The transform is camera-in-parent; never invert it.
Record Tsai residuals in the calibration result, not in the strict profile.
Re-run calib_plan and confirm extrinsics:<camera> is done.

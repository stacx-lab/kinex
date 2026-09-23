---
name: calibrate-tcp-offset
description: Measure the flange-to-tool-tip offset — read the controller's configured TCP first, else touch one fixed point from several orientations (pivot method). Use for a gripper extrinsics item when its canonical frame is the TCP.
resolves: extrinsics:gripper
---

# TCP offset calibration (touch-point / pivot)

Fills `extrinsics:<gripper>` when the gripper’s canonical frame is its tool tip.
If the TCP is instead a named intrinsic frame, preserve the device mount and
calibrate that local transform; this mount-writing procedure does not apply. The math (least squares over
stacked (Ri − Rj) t = pj − pi) is `scripts/fit_tcp.py` (numpy). Scratch:
`.kinex/calib/calibrate-tcp-offset/`.

Run scripts with the prepared Python and `PYTHONPATH=<kinex-root>/python`.
Scratch paths are workspace-relative; pass absolute evidence paths to scripts.

## 0. Automate first — zero-touch paths, in order

1. **Controller-configured TCP** (UFACTORY `get_tcp_offset`, UR `get_tcp`, Franka `F_T_EE`):
   inspect it through the vendor SDK during setup. Keep the fixed driver action contract.
   Confirm that it describes the mounted tool; persist with source "introspected",
   method "introspection", and calibrated_at when known. Archive evidence outside the profile.
2. **Tool datasheet**: the exact model's published TCP → persist with source "user" and the
   reference in the calibration evidence, outside the profile.
3. Only then the touch-point procedure below.

## 1. Preconditions

- `device <arm>` read succeeds BEFORE any physical prep (do not have the user mount tools for
  a dead channel).
- Read `data.frame_poses.flange` (or the declared attachment frame): the driver already removes any reported TCP offset using
  intrinsics.kinematics.feedback and frame_to_reported. Do not subtract it again.
- A rigid pointed tool (a gripper can pinch a rod) and a FIXED sharp reference point (nail
  tip, fixture corner). `uv run --project .kinex/python python -c "import numpy"`.
- Ask whether the robot has free-drive / hand-guiding and strongly prefer it: the user moves
  the arm, you only read state — no commanded motion near contact.
- **Repeatability pre-check** (two touches): touch the point twice from the SAME
  orientation, `calib_sample` each; the flange positions must agree within ~3 mm, else the
  fixture or tool is moving — fix that first.

## 2. Collect 6–8 samples (≥ 4)

Contact rules: NEVER command motion while the tool is in contact; the contact approach stays
interactive because only the user can report "touching". Per sample:
1. The user brings the tip EXACTLY onto the point from a substantially different orientation
   (≥ 20° from every kept sample — aim higher). Free-drive: hand-guided. Otherwise: retract
   10 cm, use `move_to` pose goals in `<arm>` for the new orientation, then
   approach in user-confirmed ~5 mm steps until "touching". Direct writes accept joint
   reference sequences only. Use move_to planning rates and speedFraction to slow contact approaches.
2. `calib_sample deviceID=<arm> routine=calibrate-tcp-offset settle={...}
   note="touch N, <orientation description>"`.
3. **Validate as you go**: check the new quaternion's angular distance to every kept sample
   (≥ 20°); reject and redo a touch that is too close — never trust "I used a different
   orientation" without checking. From sample 4 on, run the solver after every sample and
   watch the residual: one bad touch shows up immediately.

## 3. Solve

    uv run --project .kinex/python python scripts/fit_tcp.py --samples samples.json --frame flange

    → {"ok": true, "tcp_translation_m": [x, y, z], "fixed_point_m": [...],
       "residual_mm": 1.2, "per_sample_mm": [...], "n": 7}

## 4. Quality gate

- residual_mm < 5: good.
- 5–10: warn (tool flex? point drifted? inconsistent touches); optionally drop the worst
  per_sample_mm outlier and re-solve.
- > 10: do not persist; recollect with more careful touches.

## 5. Persist and verify

Clear needs_calibration explicitly with null only when the complete item is resolved.

Pivot calibration observes position only. Preserve the calibrated mount rotation; if
unknown, leave rotation_xyzw as "???" and keep the extrinsics item unresolved until
orientation is established. Identity is valid only for deliberately aligned frames.

    calib_write kind=device data={
      "name": "<gripper>",
      "extrinsics": {"source": "calibration", "method": "tcp_pivot",
        "mount": {"parent": "<arm>", "parent_frame": "flange",
                  "translation_m": [x, y, z]}}}

Re-run calib_plan. If orientation remains unknown, keep the request queued and report
the translation as a partial result. Clear the request only after orientation is established.

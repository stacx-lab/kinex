---
name: calibrate-joint-range-workspace
description: Resolve joint limits from its profile-owned model; measure optional world geometry when requested. Use for queued joint or world intrinsics items.
resolves: intrinsics:joint, intrinsics:world
---

# Joint range + workspace calibration

Fills `intrinsics:<arm>` joint limits (and the named home configuration if missing) and the `world` device's
bounds + surfaces (`intrinsics:world`). Script: `scripts/estimate_reach.py` (numpy + PyYAML).

In the examples, `<core-python>` is `python.executable` from context; set `PYTHONPATH` to `python.library` for the command.

## 0. Automate first — the zero-human path

Joint model introspection needs no motion:
1. **Joint limits**: `device_calibrate routine=urdf-introspect deviceID=<arm>` resolves joint
   metadata from that device's intrinsics.model URDF path and
   base_link/tip_link selection without duplicating the model in profile.yaml.
   For serial_chain or joints models, use model.joints directly.
   Search vendor model metadata before asking the user to measure missing limits.
2. **Optional reach estimate** (analysis only; not world geometry):

       "<core-python>" scripts/estimate_reach.py --profile /path/to/devices/arm/profile.yaml \
         --samples 20000 --percentile 99

       → {"ok": true, "frame": "arm", "aabb_min": [...], "aabb_max": [...], "max_reach_m": 0.85, "samples": 20000}

   Monte-Carlo FK uses the same URDF/serial_chain model and limits as the driver.
   Driver-only models have no offline geometry. Continuous joints sample one full turn.
   This estimate describes the modeled chain tip in the canonical device frame,
   without collision checking.

Persist the joint model and re-run calib_plan. Do not write sampled reachability into world bounds. Continue below only when model limits are unavailable
or when the user wants MEASURED limits (rare: URDF limits are the manufacturer's).

## Safety for sweeps (the strictest of the skills)

Every sweep step moves TOWARD AN UNKNOWN HARD STOP:
- surroundings clear, payload removed, user at the e-stop with hands clear;
- ONE joint at a time: small angular steps for revolute joints (2–5°, sent in radians),
  small linear steps for prismatic joints (sent in metres). Use move_to with speedFraction 0.05;
- confirm with the user every few steps; stop the direction the moment they say "near the
  stop", a fault appears, or a step does not reach its target;
- the user watches for SELF-COLLISION near limits (elbow into base, wrist into forearm).

## 1. Measured joint limits (fallback)

`device <arm>` read must succeed before any physical prep. Method (question tool, first is
recommended):
1. **Free-drive recording**: the user pushes each joint by hand to both stops while you
   `calib_sample` (settle detection says when they hold still); record min/max per joint.
2. **Guided sweep**: per joint from neutral, `device <arm> "write"` using the joint-type-specific increments and supported speed setting above, `calib_sample` after every step; stop the direction on fault,
   no-progress or user signal; back off by a small joint-type-appropriate margin → max; same negative → min; return to neutral.

Persist measured limits in the device-owned model: update the referenced URDF
joint limits, or the corresponding entries in model.joints for explicit
serial_chain/driver models. Keep complete fixed joint records (name, type, limits,
max_velocity, max_effort); unavailable ratings are null. Preserve model geometry
and IK settings. Write home as {joint_name: position, ...}, covering every joint.
Record intrinsics.source:calibration and method:joint_range. Do not add duplicate
intrinsics.joints, dof, actions or home_joints fields.

## 2. Optional measured world geometry

Only when world-referenced spatial information is needed, record independently
measured bounds and surfaces using the world DEVICE.md guide from the discovered
device guide roots. An AABB
of reachable end-effector samples is not an environment measurement. Neither
joint calibration nor task readiness requires a world profile.

Bounds may be null, with individual open sides also represented by null.
Surfaces require a measured world-frame pose (translation_m, rotation_xyzw) and
an extent (rectangle size_m, polygon vertices_m, explicit unbounded, or ???).
Do not infer a desk from an AABB minimum or assume unknown extent is infinite.
For existing TCP samples, preserve the recorded frame and apply each offset only
once. Use method manual, survey, or plane_fit as appropriate, and calibrated_at
only when the measurement time is known. Raw sample evidence belongs outside the
fixed profile. No free-form notes, automatic margins, or target-frame policies.

## 3. Verify / abort

Clear needs_calibration with null only for fully resolved items.
Re-run `calib_plan`: `intrinsics:<arm>` done; world remains optional. On abort persist only
what was fully measured and update the remaining markers (`calib_write kind=needed`) with
where the sweep stopped and why.

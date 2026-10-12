---
name: dexterous_hand
type: dexterous_hand
description: dexterous hand control and observation contract.
---

## Setup

Follow setup-device for registration and lifecycle ownership. Load waits for
readiness; status only observes; unload stops motion and releases owned resources.
Use `???` for unresolved facts and `null` only where the schema permits it.

Optional `geometry.description` describes documented finger arrangement, shape
and limitations. It can stand alone without a kinematic model of the fingers.
Optional `geometry.fingers` predicts nominal fingertip poses. Each finger declares
`chain`, `tip_frame`, and `tip_offset` (distal-link to nominal tip, metres and xyzw).
Moving chain links name a joint from `intrinsics.model` directly in `joint`, with
`origin`, `axis`, `anchor`, and `reference`; fixed links contain only `origin`.
Chain order defines traversal order. Each finger must use at least one joint,
without repetitions; different fingers may share joints. Do not declare a separate
finger `joints` list. Ordinary joint profiles do not accept hand geometry.

Every chain starts at the device base. Palm and fixed grasp/TCP references are
ordinary entries in `intrinsics.frames`; they do not change the chain origin.
Geometry declares computed tip frames directly; omit duplicate entries from frames.
For example, a moving link uses `joint: index_knuckle`, not a numeric local index.

Optional `geometry.center` declares a computed `frame`, nonnegative `weights`
keyed by finger whose sum is one, and `rotation_xyzw` in hand coordinates.
It requires finger geometry. Omitted fingers have zero weight; center orientation
stays fixed while its weighted fingertip position moves. It is a convenience
reference, not a contact measurement, object center, or recommended grasp target.

Reads return joint measurements without frame poses. Named tips and optional
center resolve on demand at sampled joint positions; advertise `fk` only when
finger geometry or endpoint FK is present. Description alone does not enable FK.
URDF joint references are checked when the harness resolves the model; an
unresolved model cannot support prediction.

intrinsics.model is {format:joints,joints:[...]} for arbitrary joint sets, {format:serial_chain,joints,chain}, or {format:urdf,path,base_link,tip_link}. Each joint declares name, type (revolute/continuous/prismatic), limits (null only for continuous), max_velocity and max_effort (nullable); max_acceleration is optional. Geometry is optional.

kinematics:null needs no solver. Otherwise declare frame, fk (numerical/driver/null), ik (numerical DLS/driver/null), and frame_to_reported. Driver IK supplies frame_to_solver and residual tolerances. kinematics.frame declares the computed endpoint; do not repeat it in intrinsics.frames. Numerical solvers require a serial model; IK requires FK verification.

Numerical `ik.budget` optionally sets `max_attempts` (5 total), `attempt_time_s`
(0.02) and `max_time_s` (0.1). Existing profiles inherit these defaults;
`max_iterations` also limits each attempt. The original seed is tried first,
then deterministic nearby seeds (within 0.35 rad or 5% of the prismatic range
around the original seed, clamped to limits); selection prefers the verified
configuration nearest the seed. Tolerances remain strict. Budgets are cooperative
and apply per target; nearest preference is not a hard waypoint-step limit.

home names every joint or is null. feedback declares velocities and efforts. stop declares behavior and affected_devices. intrinsics.frames declares additional references as {parent_frame, translation_m, rotation_xyzw}. A null parent means the device base; either transform component may be null when unknown. extrinsics supplies only a mount or measured pose_frame.

### Frame feedback

Reads and write states omit `frame_poses`; resolve live frames through FK from
measured joint positions. FK must preserve measured limit overshoot, while IK
solutions and explicit seeds satisfy limits. Return the selected `frame` and
`reference_frame` with FK/IK results; fail on unknown required transforms.

### Profile

```yaml
name: dexterous_hand
type: dexterous_hand
loaded: false
access:
  source: unknown
  method: unknown
  calibrated_at: null
  connection: ???
  driver:
    entry: driver.py
    actions:
    - read
    - write
    - stop
    - load
    - unload
    - status
    persistent: true
    timeout_s: 30
intrinsics:
  frames: {}
  source: unknown
  method: unknown
  calibrated_at: null
  model: ???
  kinematics: null
  home: null
  control: ???
  feedback: ???
  stop: ???
extrinsics:
  source: unknown
  mount: ???
```

## Use

`servo({device, joints, speedFraction?})` plans and submits a smooth trajectory
from measured finger positions. It waits the duration on a loaded world clock.
Set `block=false` to return immediately. Verify arrival with measured feedback.
Pose goals require declared endpoint IK; finger geometry alone supplies
predictions, not pose-goal control.

`write({actions, duration_s})` takes absolute joint vectors in model order
(radians/metres); the final reference remains active. Reads return positions,
velocities, efforts, faults and timestamp. Unsupported velocity/effort channels
are empty arrays; reads omit frame poses.

FK takes `joints` and resolves modeled tips, an optional center or fixed descendants.
Specify `frame` when `kinematics` is null; otherwise it defaults to
`kinematics.frame`. `reference_frame` is null for the hand base or a fixed base
frame. These poses are geometric predictions, not contact measurements.
IK takes `pose` and optional `seed`; it requires a
declared solver and targets its endpoint or fixed descendants. FK preserves
measured overshoot; IK enforces limits.
`seed` is the initial joint guess; omission uses measured joints projected into
limits. Numerical IK prefers the verified configuration nearest the seed;
profile `ik.budget` controls its search limits.

For arm positioning, use an explicitly declared fixed hand reference and the
hand-to-arm mount. A moving center is not a fixed tool offset. Finger FK predicts
poses but does not choose closing postures or solve multi-finger IK; `home` does
not necessarily mean open. Observe the object to verify a grasp.

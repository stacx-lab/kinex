---
name: joint
type: joint
description: joint control and observation contract.
---

## Setup

Follow setup-device for registration and lifecycle ownership. Load waits for
readiness; status only observes; unload stops motion and releases owned resources.
Use `???` for unresolved facts and `null` only where the schema permits it.

intrinsics.model is {format:joints,joints:[...]} for arbitrary joint sets, {format:serial_chain,joints,chain}, or {format:urdf,path,base_link,tip_link}. Each joint declares name, type (revolute/continuous/prismatic), limits (null only for continuous), max_velocity and max_effort (nullable); max_acceleration is optional. Geometry is optional.

kinematics:null needs no solver. Otherwise declare frame, fk (numerical/driver/null), ik (numerical DLS/driver/null), and frame_to_reported. Driver IK supplies frame_to_solver and residual tolerances. kinematics.frame declares the computed endpoint; do not repeat it in intrinsics.frames. Numerical solvers require a serial model; IK requires FK verification.

Numerical `ik.budget` optionally sets `max_attempts` (5 total), `attempt_time_s`
(0.02) and `max_time_s` (0.1). Existing profiles inherit these defaults;
`max_iterations` also limits each attempt. The original seed is tried first,
then deterministic nearby seeds (within 0.35 rad or 5% of the prismatic range
around the original seed, clamped to limits); selection prefers the verified
configuration nearest the seed. Tolerances remain strict. Budgets are cooperative
and apply per target; nearest preference is not a hard waypoint-step limit.

feedback declares velocities and efforts. stop declares behavior and affected_devices. intrinsics.frames declares additional references as {parent_frame, translation_m, rotation_xyzw}. A null parent means the device base; either transform component may be null when unknown. extrinsics supplies only a mount or measured pose_frame.

home names every joint or is null. Revolute joints may start up to 1° outside
limits when returning to declared home; out-of-limit references must move inward
and the final target must satisfy the limits. This fixed margin is not a profile
field. Prismatic joints retain strict limits.

### Frame feedback

Reads and write states omit `frame_poses`; resolve live frames through FK from
measured joint positions. FK must preserve measured limit overshoot, while IK
solutions and explicit seeds satisfy limits. Return the selected `frame` and
`reference_frame` with FK/IK results; fail on unknown required transforms.

### Profile

```yaml
name: joint
type: joint
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
  home: ???
  control: ???
  feedback: ???
  stop: ???
extrinsics:
  source: unknown
  mount: ???
```

## Use

`write({actions, duration_s})` takes a sequence of absolute joint vectors in
model order (radians/metres); the final reference remains active.
`read()` returns positions, velocities, efforts, faults and timestamp.
Unsupported velocity/effort channels are empty arrays; poses come from FK.

FK takes `joints`; IK takes `pose` and optional `seed`.
Both name `frame` (default `kinematics.frame`) and `reference_frame` (null means
device base).
Targets are the modeled endpoint or fixed descendants; references must be fixed
to the base. FK preserves measured limit overshoot; IK enforces limits.
`seed` is the initial joint guess; omission uses measured joints projected into
limits. Numerical IK prefers the verified configuration nearest the seed;
profile `ik.budget` controls its search limits.
Convert external-frame targets into a declared reference frame before calling IK.

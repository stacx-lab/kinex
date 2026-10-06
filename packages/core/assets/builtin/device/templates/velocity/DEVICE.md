---
name: velocity
type: velocity
description: velocity control and observation contract.
---

## Setup

Follow setup-device for registration and lifecycle ownership. Load waits for
readiness; status only observes; unload stops motion and releases owned resources.
Use `???` for unresolved facts and `null` only where the schema permits it.

control contains mode:motion, body_frame and modes. Each preset has nullable velocity {frame:body|heading,components:[{axis,units,bounds}]} and posture {reference,components:[{axis,units,bounds,default}]}. Implement period_s and nonblocking set_target hooks; the shared driver owns the buffer. feedback declares velocity_frame and velocity_components. The base is an unlocalized root: omit mount and pose_frame. Declare normalized input bounds when known; limit_handling:native delegates saturation to the controller.

### Profile

```yaml
name: velocity
type: velocity
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
  control: ???
  feedback: ???
  stop: ???
extrinsics:
  source: unknown
```

## Use

`write({mode, velocity?, posture?, duration_s})` requires named-axis dictionaries,
for example `{mode:"drive", velocity:{vx:0.05, vy:0, wz:0}, duration_s:0.5}`.
Use the axes, units and frames in `control.modes`; normalized inputs are not m/s.
Velocity automatically becomes zero after `duration_s`; posture remains active.
No explicit stop is needed for normal completion. Use stop to interrupt early or
respond to faults. A stop immediately after write cuts the command short.

Actual displacement may differ from velocity × duration due to imperfect tracking and startup delays;
very short commands may produce no visible motion.

Reads and write states return `velocities`, `faults` and `timestamp`, without
global `pose`. Velocity order and frame follow `feedback.velocity_components`
and `feedback.velocity_frame`, in m/s and rad/s. Optional feedback includes
`height_m` and parent-relative `frame_poses`. Use frame queries to compose
transforms and call-local estimates to relate the base to world.

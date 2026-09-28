---
name: joint
type: joint
description: joint control and observation contract.
---

## Use

`write({actions, duration_s})` submits absolute joint vectors in model order
(radians/metres). The driver consumes the buffer at its fixed control cadence.
The last reference remains active after the buffer completes.
New valid writes replace pending actions without stopping. Results contain
`execution_id`, actual `elapsed_s` and measured `state`.
Use `world.wait({duration_s})` to wait for execution. Stop clears the buffer.

## Setup

Follow setup-device for registration and lifecycle ownership. Load waits for
readiness; status only observes; unload stops motion and releases owned resources.
Use `???` for unresolved facts and `null` only where the schema permits it.

intrinsics.model is {format:joints,joints:[...]} for arbitrary joint sets, {format:serial_chain,joints,chain}, or {format:urdf,path,base_link,tip_link}. Each joint declares name, type (revolute/continuous/prismatic), limits (null only for continuous), max_velocity and max_effort (nullable); max_acceleration is optional. Geometry is optional.

kinematics:null needs no solver. Otherwise declare frame, fk (numerical/driver/null), ik (numerical DLS/driver/null), feedback (driver/fk), and frame_to_reported. Driver IK supplies frame_to_solver and residual tolerances. Declare the tip under intrinsics.frames. Numerical solvers require a serial model; IK requires FK verification.

home names every joint or is null. feedback declares velocities, efforts and clock (unix/monotonic/simulation). stop declares behavior and affected_devices. intrinsics.frames maps local names to fixed poses or null for read.frame_poses feedback. extrinsics supplies only a mount or measured pose_frame.

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

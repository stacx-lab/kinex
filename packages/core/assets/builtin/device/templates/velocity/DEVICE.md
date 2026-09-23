---
name: velocity
type: velocity
description: velocity control and observation contract.
---

## Use

`write({mode, velocity?, posture?, for_s})` holds a preset command for positive
`for_s` device seconds and returns `accepted`, `elapsed_s`, `reached` and `state`.
Axes, units and frames come from `control.modes`. Use `drive` for a timed hold
with automatic final stop. Raw write completion does not clear a standing command.
Reads return measured pose, velocities, faults, time and named `frame_poses`.

## Setup

Follow setup-device for registration and lifecycle ownership. Load waits for
readiness; status only observes; unload stops motion and releases owned resources.
Use `???` for unresolved facts and `null` only where the schema permits it.

control contains mode:motion, body_frame and modes. Each preset has nullable velocity {frame:body|heading,components:[{axis,units,bounds}]} and posture {reference,components:[{axis,units,bounds,default}]}. send_target executes for for_s on the device clock and reports measured elapsed_s and state. feedback declares pose_frame (null if unlocalized), velocity_frame, velocity_components and clock. Root placement comes from measured feedback, never a fixed mount.

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

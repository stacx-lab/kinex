---
name: velocity
type: velocity
description: velocity control and observation contract.
---

## Setup

Follow setup-device for registration and lifecycle ownership. Load waits for
readiness; status only observes; unload stops motion and releases owned resources.
Use `???` for unresolved facts and `null` only where the schema permits it.

control contains mode:motion, body_frame and modes. Each preset has nullable velocity {frame:body|heading,components:[{axis,units,bounds}]} and posture {reference,components:[{axis,units,bounds,default}]}. Implement period_s and nonblocking set_target hooks; the shared driver owns the buffer. feedback declares pose_frame (null if unlocalized), velocity_frame, velocity_components and clock. Root placement comes from measured feedback, never a fixed mount.

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

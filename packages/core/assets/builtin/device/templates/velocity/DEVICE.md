---
name: velocity
type: velocity
description: velocity control and observation contract.
---

## Use

Every write requires a positive `for_s` in the device's own clock. The driver
returns `accepted`, `elapsed_s`, boolean `reached`, and the resulting `state`.
SDK hooks must return that report; acknowledgment alone is insufficient. Joint
arrival may end a segment early when `arrive` is supplied. Call `stop` explicitly
to halt a standing goal; the segment budget bounds the call, not goal lifetime.


write {mode,velocity?,posture?,for_s} uses exactly the axes, units and frames declared for that controller preset. vx/vy/vz are linear velocity, wx/wy/wz angular velocity; yaw is a posture angle and height is metres. Unsupported axes fail before motion. `drive` commands this type for a timed hold, optionally ending on an `until` predicate. Reads report measured root pose, velocities, faults, acquisition time and named frame_poses. Stop can hold, stand or halt according to the profile.

## Setup

Load initializes the connection and any owned control/streaming service, waiting
for readiness; status only observes. Unload stops active work according to the
profile and releases every owned resource, even if a cleanup stage fails. Follow
setup-device for service ownership, partial-startup rollback and exit cleanup.

Use setup-device for registration and driver lifecycle. Fill the starter with known facts; `???` marks unresolved values and `null` has the field’s declared meaning.

control contains mode:motion, body_frame and modes. Each preset has nullable velocity {frame:body|heading,components:[{axis,units,bounds}]} and posture {reference,components:[{axis,units,bounds,default}]}. Whether physics advances on a background clock or inside your write is your driver's business: set Driver.background_clock and serve it, or advance physics inside send_target. Either way a write runs the goal for the caller's for_s and reports the device time it spent, so a command needs no separate expiry. feedback declares pose_frame (null if unlocalized), velocity_frame, velocity_components and clock. Root placement comes from measured feedback, never a fixed mount.

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

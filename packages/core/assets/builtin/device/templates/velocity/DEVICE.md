---
name: velocity
type: velocity
description: velocity control and observation contract.
---

## Setup

Follow setup-device for provisioning, registration, lifecycle and shared checks.
The base is an unlocalized root: omit `extrinsics.mount` and `pose_frame`.

### Profile fields

| Field | Contract |
| --- | --- |
| `control` | `mode: motion` identifies the control contract; `body_frame` names the body frame. Each entry in `modes` combines `velocity` and `posture` channels; use `null` for an unsupported channel. At least one channel must be supported. |
| `control.modes.<name>.velocity` | `{frame: body\|heading, components: [{axis, units, bounds}]}`. Unique axes: `vx/vy/vz` in m/s, `wx/wy/wz` in rad/s, or explicitly `normalized` inputs. |
| `control.modes.<name>.posture` | `{reference, components: [{axis, units, bounds, default}]}`. Unique axes: `height` in m, `roll/pitch/yaw` in rad. Defaults must satisfy bounds; height bounds must be positive. |
| Component `bounds` | `{min, max}` with `min < max`; velocity bounds include zero. `null` means no declared bound; velocity `???` remains unresolved. `control.limit_handling: native` delegates saturation to the controller. |
| `feedback` | `velocity_components` lists measured axes in return order; `velocity_frame` names their frame. With no velocity measurement, use `[]` and `null`, respectively. |
| `stop` | `{behavior, affected_devices}`. Behavior is `stand`, `hold`, `halt` or `controller_emergency_stop`; choose the implemented behavior and scope. |

### Driver hooks

Complete the sibling [driver scaffold](driver.py); its buffer requires
`persistent: true`. `period_s` is a positive command period in seconds.
`set_target(handle, command)` receives the validated command dictionary repeatedly
during its interval; apply it without waiting for `duration_s` or restarting a
whole-duration SDK operation on every tick. `read_state` returns the Use feedback.

Expiry calls `halt(handle, target)` rather than sending zero velocity itself.
Implement zero travel while preserving posture/balance for expiry, explicit stop
and cleanup. Handle `target=None` before the first write. Declaring `stop` does
not implement it. Verify replacement, expiry and explicit stop, including before
the first write, with posture retained.

### Response behavior

Displacement may differ from velocity × duration; short commands may not visibly move.
During authorized setup checks, measure response for each supported motion mode.
Record observed thresholds in `intrinsics.control.modes.<mode>.response`:

- `min_abs_vel`: per-axis translational magnitudes, such as `{vx: 0.05}`.
- `min_abs_w`: per-axis angular magnitudes, such as `{wz: 0.1}`.
- `min_duration_s`: positive duration in seconds that produced measurable response
  at the tested speeds.

Axis values are nonnegative and use the declared command units, including normalized
units where applicable. Record only tested axes; omit unknown fields. These are
observations under tested conditions, not universal deadbands or enforced command
limits. Preserve test conditions and evidence in the setup report, including
direction, posture, load, surface, speeds, durations and observed response.
Zero and smaller commands remain valid; do not clamp them to these thresholds.

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

`mode` selects a named profile entry, such as `locomotion` or `drive`.
Velocity and posture are fields within that mode, not separate modes: velocity
sets travel rates, while posture sets height/orientation targets.
`write({mode, velocity?, posture?, duration_s})` requires positive `duration_s`
and every channel and axis declared by the selected mode. Use named-axis
dictionaries; omit unsupported channels. Posture defaults do not fill omitted
arguments. Follow `control.modes` units and frames; normalized inputs are not m/s.
For a locomotion mode declaring `vx/vy/wz` and `height/roll/pitch` in metric units:
`{mode:"locomotion", velocity:{vx:0.05, vy:0, wz:0}, posture:{height:0.3, roll:0, pitch:0}, duration_s:0.5}`.
Zero velocity requests stationary posture control in the same mode.

Velocity expires to zero; posture remains active. Stop interrupts early or
responds to faults; immediately stopping after write cuts motion short.
Displacement may differ from velocity × duration; short commands may not visibly move.
Use the selected mode's `response`, when present, to choose effective speed and
duration; verify motion through feedback. Its thresholds do not enforce limits.

Reads and write states return `velocities` in `feedback.velocity_components`
order and `feedback.velocity_frame`, in m/s and rad/s; use `[]` when no axes are measured.
They also return `faults: [{code: string}]` (`[]` when clear) and numeric
`timestamp` in seconds, without global `pose`. Optional `height_m` is metres.
Optional `frame_poses` maps declared dynamic frame names to parent-relative
`[x,y,z,qx,qy,qz,qw]`, with metre translations and unit xyzw quaternions. Declare them in
`intrinsics.frames` with unknown translation or rotation (`null`). Use frame
queries and explicit estimates for base-to-world relationships.

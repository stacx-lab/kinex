---
name: gripper
type: gripper
description: gripper control and observation contract.
---

## Setup

Follow setup-device for registration and lifecycle ownership. Load waits for
readiness; status only observes; unload stops motion and releases owned resources.
Use `???` for unresolved facts and `null` only where the schema permits it.

control.mode is position or direction. Position declares units, bounds, resolution, open_target, close_target and optional speed. Direction declares opposite -1/+1 endpoints; zero holds. feedback declares aperture_m support. Raw finger measurements and aperture conversion stay inside the driver. stop declares behavior and scope. A gripper mount locates its mounting base; finger joints do not turn it into a joint device.

### Geometry

`extrinsics.mount` locates the gripper base in its parent attachment frame.
`intrinsics.frames.tcp` locates the TCP relative to that base.
Axes are unit vectors expressed in the gripper base frame. `approach_axis` is the
preferred insertion direction. `closing_axis` is an unoriented line of jaw motion
only when it is fixed; use `null` for angular, adaptive, or multi-axis mechanisms.
`???` means unknown; null means no single applicable axis. Never infer either axis
from the mount quaternion alone.

`geometry.description` may describe finger shape, pads, dimensions and limitations
supported by device documentation or calibration. This is the explicit exception
to structured-only profile facts. Do not invent unknown dimensions or advertise
collision clearance from aperture alone. Missing geometry does not prevent control.

```yaml
frames:
  tcp: {parent_frame: null, translation_m: [0, 0, 0.097], rotation_xyzw: [0, 0, 0, 1]}
geometry:
  description: Two opposing sliding fingers with 16 by 16 mm inner pads.
  approach_axis: [0, 0, 1]
  closing_axis: [1, 0, 0]
```

Frames describe TCP and other fixed references. Null parent means device base;
null transform components mean unknown. Unknown gripper frames cannot be resolved
from reads. Grippers do not expose live finger frames or contact-frame entries.

`intrinsics.aperture_m` bounds describe the physical opening range.
`feedback: {aperture_m: true}` declares available measurements.
Reads return `aperture_m`, faults and timestamp; write state uses
the same fields. Neither returns `frame_poses`. Unsupported measurements
are null. Drivers compute physical aperture from measured state, clamping overlap
to zero; commanded targets are not measurements. Aperture is not grasp detection.
Use `world` to read time and wait. Finger descriptions belong in `geometry.description`.

### Profile

```yaml
name: gripper
type: gripper
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
  aperture_m: null
  control: ???
  feedback: ???
  stop: ???
extrinsics:
  source: unknown
  mount: ???
```

## Use

`write({actions: [value, ...], duration_s})` uses profile command units and
open/close endpoints. Direction mode uses signs in [-1,1]; zero holds.
`speedFraction` is optional when supported. The final reference remains active.

Reads and write states contain `aperture_m`, `faults` and `timestamp`.
Aperture is measured opening in metres, or null when unsupported; it does not
indicate grasp success. Finger joints, sensors and live finger poses are omitted.

The mount places the gripper base; `gripper:tcp` is a separate local tool frame.
Unknown frame transforms stay unavailable. Geometry describes approach/closing
axes and optionally finger shape; aperture alone does not establish clearance.

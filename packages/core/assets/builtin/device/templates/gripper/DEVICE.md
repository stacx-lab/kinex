---
name: gripper
type: gripper
description: gripper control and observation contract.
---

## Setup

Follow setup-device for registration and lifecycle ownership. Load waits for
readiness; status only observes; unload stops motion and releases owned resources.
Use `???` for unresolved facts and `null` only where the schema permits it.

control.mode is position or direction. Position declares units, bounds, resolution, open_target, close_target and optional speed. Direction declares opposite -1/+1 endpoints and increment_per_interval. feedback positions name measured channels and units; aperture_model optionally converts them to metres. stop declares behavior and scope. A gripper mount locates its TCP; finger joints do not turn it into a joint device.

### Geometry

`extrinsics.mount` locates the canonical TCP, not necessarily the attachment surface.
`intrinsics.geometry.description` must say what physical point that TCP denotes.
Axes are unit vectors expressed in this canonical frame. `approach_axis` is the
preferred insertion direction. `closing_axis` is an unoriented line of jaw motion
only when it is fixed; use `null` for angular, adaptive, or multi-axis mechanisms.
`???` means unknown; null means no single applicable axis. Never infer either axis
from the mount quaternion alone.

Named `contacts` reference device-local `intrinsics.frames`. Contact frames sit on
the contact surface, with local +Z toward the object. `size_m: [width, height]`
is the full rectangular extent along local X/Y; null means no rectangular model,
`???` means unmeasured. These patches are not collision envelopes or safe insertion
depths. Multiple patches may describe one curved pad. The template assumes neither
a finger count nor symmetric motion. Missing geometry does not prevent control.

A parallel-jaw example (poses below are supplied by the driver):

```yaml
frames: {left_pad: null, right_pad: null}
geometry:
  description: TCP is the midpoint between the jaws at the nominal grasp height.
  approach_axis: [0, 0, 1]
  closing_axis: [1, 0, 0]
  contacts:
    left: {frame: left_pad, size_m: [0.016, 0.016]}
    right: {frame: right_pad, size_m: [0.016, 0.016]}
```

An angular or adaptive three-finger example:

```yaml
frames: {pad_a: null, pad_b: null, pad_c: null}
geometry:
  description: TCP is the palm reference; pads rotate and translate during closure.
  approach_axis: [0, 0, 1]
  closing_axis: null
  contacts:
    a: {frame: pad_a, size_m: null}
    b: {frame: pad_b, size_m: null}
    c: {frame: pad_c, size_m: null}
```

Declare fixed frame poses as seven-element poses; use null only when every read
supplies that frame in `frame_poses`. Unknown poses are `???`. Resolve moving pads
using feedback, not a transform measured at one arbitrary opening.

`aperture_m` bounds and `feedback.aperture_model` describe the gap between inner
contact surfaces, not joint travel. Use the affine model only when physically valid;
nonlinear or multi-gap mechanisms may leave it null. Reads clamp physical aperture
to zero if soft contact produces numerical overlap. Aperture is not grasp detection.

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

`write({actions: [value, ...], duration_s})` submits a flat sequence of commands.
Use `[value]` for one command. Values use the profile's units and command semantics.
Optional `speedFraction` applies to the whole sequence when supported.
The final reference remains active after the buffer completes.
New valid writes replace pending actions without stopping. Results contain
`execution_id`, actual `elapsed_s` and measured `state`.
Use `world.wait({duration_s})` to wait for execution. Stop clears the buffer.

---
name: gripper
type: gripper
description: gripper control and observation contract.
---

## Use

Every write requires a positive `for_s` in the device's own clock. The driver
returns `accepted`, `elapsed_s`, boolean `reached`, and the resulting `state`.
SDK hooks must return that report; acknowledgment alone is insufficient. Joint
arrival may end a segment early when `arrive` is supplied. Call `stop` explicitly
to halt a standing goal; the segment budget bounds the call, not goal lifetime.


A scalar gripper. write {target:[value],speedFraction?,for_s} uses declared position units or signed direction (-1/0/+1). Command dimensions are independent of measured finger channels. read reports positions, velocities, faults, time and supported force/contact channels. Acceptance is not closure or grasp success.

The canonical gripper frame is its TCP. Read `intrinsics.geometry` for its physical meaning, approach direction, fixed jaw-closing axis (when applicable), and contact patches. Axes are in the canonical frame; contact frames use local +Z toward the object and local XY along the pad. Resolve moving patches through `relative_pose`. Geometry may be unknown; do not guess it from the mount or equate joint travel with physical opening.

## Setup

Load initializes the connection and any owned control/streaming service, waiting
for readiness; status only observes. Unload stops active work according to the
profile and releases every owned resource, even if a cleanup stage fails. Follow
setup-device for service ownership, partial-startup rollback and exit cleanup.

Use setup-device for registration and driver lifecycle. Fill the starter with known facts; `???` marks unresolved values and `null` has the field’s declared meaning.

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

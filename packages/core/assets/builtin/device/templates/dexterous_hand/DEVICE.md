---
name: dexterous_hand
type: dexterous_hand
description: dexterous hand control and observation contract.
---

## Use

Every write requires a positive `for_s` in the device's own clock. The driver
returns `accepted`, `elapsed_s`, boolean `reached`, and the resulting `state`.
SDK hooks must return that report; acknowledgment alone is insufficient. Joint
arrival may end a segment early when `arrive` is supplied. Call `stop` explicitly
to halt a standing goal; the segment budget bounds the call, not goal lifetime.


A distinct finger-joint controller. Uses the common joint command/read contract; move_to does not accept this type; run_policy does. Use device write/read or a hand-specific controller tool. Named fingertip frames are optional.

For grasp planning, inspect optional `intrinsics.geometry`. It names a fixed
`palm_frame` and `reference_frame`, plus `fingers` and a moving `center`.
Fixed poses live in `intrinsics.frames`; moving tips and center are supplied
together by `read.frame_poses`.

Use `kinex.hand.forward(profile, positions)` to predict dynamic tip/center poses
for any finite configuration in model joint order, without device calls. Measured
joint-limit overshoot is preserved; validate proposed writes with `JointDevice.command`.
`kinematics: null` does not disable this helper: it means the hand has no
single-endpoint FK/IK interface. Geometry does not establish contact, grasp success,
or collision-free motion. A nominal fingertip need not be an actual contact point.

Inside a Python tool:

```python
from kinex import device, profile
from kinex.hand import forward

hand = profile("left_hand")
state = device("left_hand")["data"]
current_tips = state["frame_poses"]
candidate = list(state["positions"])
candidate[0] += 0.05
predicted_tips = forward(hand, candidate)
```

## Setup

Load initializes the connection and any owned control/streaming service, waiting
for readiness; status only observes. Unload stops active work according to the
profile and releases every owned resource, even if a cleanup stage fails. Follow
setup-device for service ownership, partial-startup rollback and exit cleanup.

Use setup-device for registration and driver lifecycle. Fill the starter with known facts; `???` marks unresolved values and `null` has the field’s declared meaning.

Optional hand-specific `geometry` declares `description`, `palm_frame`,
`reference_frame`, `fingers`, and `center`. Each finger declares `joints` (ordered
names from the main model), `chain` (standard serial-chain links indexed within
that subset, starting in the canonical hand frame), `tip_offset` (distal-link to
nominal tip, metres and xyzw), and `tip_frame`. The center declares `frame`,
nonnegative `weights` keyed by finger whose sum is one, and a fixed
`rotation_xyzw` in hand coordinates. Declare palm/reference as distinct fixed
frames; tips and center as distinct null frames. Ordinary joint profiles do not
accept this geometry field.

Named frame poses are relative to the canonical hand frame. Each chain link's
origin is relative to the preceding link, starting in that canonical frame;
`palm_frame` does not change the chain origin.
Finger subsets may share model joints. Center weights may omit fingers (zero
weight); its orientation stays fixed in hand coordinates as its position moves.
The driver must return all declared dynamic tip/center poses from the same sample
as `positions`. Local prediction does not automatically fill missing read frames.
URDF joint references are checked when the harness resolves the model; an
unresolved model cannot support prediction.

intrinsics.model is {format:joints,joints:[...]} for arbitrary joint sets, {format:serial_chain,joints,chain}, or {format:urdf,path,base_link,tip_link}. Each joint declares name, type (revolute/continuous/prismatic), limits (null only for continuous), max_velocity and max_effort (nullable). Geometry is optional.

kinematics:null needs no solver. Otherwise declare frame, fk (numerical/driver/null), ik (numerical DLS/driver/null), feedback (driver/fk), and frame_to_reported. Driver IK supplies frame_to_solver and residual tolerances. Declare the tip under intrinsics.frames. Numerical solvers require a serial model; IK requires FK verification.

control declares mode:position, speed (null or named max_velocity and default_fraction), home names every joint or is null. feedback declares velocities, efforts and clock (unix/monotonic/simulation). stop declares behavior and affected_devices. intrinsics.frames maps local names to fixed poses or null for read.frame_poses feedback. extrinsics supplies only a mount or measured pose_frame.

### Profile

```yaml
name: dexterous_hand
type: dexterous_hand
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
  home: null
  control:
    mode: position
    speed: ???
  feedback: ???
  stop: ???
extrinsics:
  source: unknown
  mount: ???
```

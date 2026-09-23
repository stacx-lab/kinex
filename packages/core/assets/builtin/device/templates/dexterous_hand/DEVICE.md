---
name: dexterous_hand
type: dexterous_hand
description: dexterous hand control and observation contract.
---

## Use

`write({actions, freq_hz})` executes absolute joint vectors in model order
(radians/metres). The device owns timing and resampling; write does not plan or
wait for arrival. Optional `for_s` limits the execution duration.

New commands replace older motion. Completed write holds measured state in stepped execution and retains its last reference
in realtime execution. Timeout, cancellation, faults and `stop` terminate motion.
Reads never advance physics.

## Setup

Follow setup-device for registration and lifecycle ownership. Load waits for
readiness; status only observes; unload stops motion and releases owned resources.
Use `???` for unresolved facts and `null` only where the schema permits it.

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

intrinsics.model is {format:joints,joints:[...]} for arbitrary joint sets, {format:serial_chain,joints,chain}, or {format:urdf,path,base_link,tip_link}. Each joint declares name, type (revolute/continuous/prismatic), limits (null only for continuous), max_velocity and max_effort (nullable); max_acceleration is optional. Geometry is optional.

kinematics:null needs no solver. Otherwise declare frame, fk (numerical/driver/null), ik (numerical DLS/driver/null), feedback (driver/fk), and frame_to_reported. Driver IK supplies frame_to_solver and residual tolerances. Declare the tip under intrinsics.frames. Numerical solvers require a serial model; IK requires FK verification.

home names every joint or is null. feedback declares velocities, efforts and clock (unix/monotonic/simulation). stop declares behavior and affected_devices. intrinsics.frames maps local names to fixed poses or null for read.frame_poses feedback. extrinsics supplies only a mount or measured pose_frame.

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
  control: ???
  feedback: ???
  stop: ???
extrinsics:
  source: unknown
  mount: ???
```

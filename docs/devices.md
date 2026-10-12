# Device contracts

A device is a named interface to hardware, a simulator or a service. Its **type**
defines the operations, its **profile** records capabilities and configuration,
and its **driver** implements access. Physical and simulated devices use the
same contracts; Kinex provides a mock for testing, not a simulator engine.

## Types

Types describe capabilities rather than vendors or robot models. A robot can
combine several devices, such as an arm, gripper, camera and world clock.

| Type | Interface and example |
| --- | --- |
| `joint` | Joint-vector control and feedback, such as a robot arm; FK/IK when declared. |
| `dexterous_hand` | Joint-vector control with optional finger geometry and kinematics. |
| `gripper`, `suction` | Scalar actuator commands: position/direction for grippers, on/off targets for suction. |
| `velocity` | Named-axis velocity and optional posture commands, such as a mobile base. |
| `legged_base` | Mode-based SDK operations, including supported locomotion and posture transitions. |
| `rgb`, `rgbd` | Color images, with depth for RGBD cameras. |
| `imu`, `force_torque` | Inertial or force/torque observations. |
| `model` | Inference operations with profile-defined input/output contracts. |
| `detection`, `segmentation` | Model services with a standard image-and-text `detect` operation. |
| `world` | Environment clock and optional spatial reference. |
| `other` | A resource without a more specific intrinsic contract. |

An `rgbd` device satisfies an `rgb` tool requirement; `segmentation` satisfies a
`detection` requirement. Other types must match explicitly.

## Profiles

Each `.kinex/devices/<name>/profile.yaml` describes one device. The inventory comes
from these profiles; `.kinex/workspace.yaml` holds assembly identity, simulator
metadata and workspace safety configuration.

| Field | Contract |
| --- | --- |
| `name`, `type` | Device identity and the schema governing its interface. |
| `loaded` | Activation intent, not proof of a ready connection. Registration leaves devices unloaded; profile edits preserve this intent. |
| `access` | Connection facts and driver configuration: entry, optional interpreter, declared actions, persistence and timeout. |
| `intrinsics` | Type-specific facts, such as joint models, camera calibration, control limits or inference operations. |
| `extrinsics` | Physical placement: a fixed mount or a measured pose reference. Omitted for world and model devices. |
| `meta` | Creation and update timestamps. |

Profile sections track provenance with `source` and unresolved work with
`needs_calibration`. `???` denotes an unresolved fact; `null` follows the field's
meaning. Resolve calibration requests explicitly through validated profile writes.
For example, a wrist camera's intrinsics describe image geometry, while its
extrinsics describe its mounting transform to the arm.

Device guides supply Setup, Profile and Use instructions; only Use enters normal
loaded-device context. Shared type guides define conventions. Custom instance
`DEVICE.md` files are supported only for `legged_base`. See
[setup](setup.md) for calibration evidence.

### Frames and poses

Frames form a forest; world is optional and missing relationships are not identity
transforms. Local frames declare `parent_frame`, `translation_m` and
`rotation_xyzw`; null parent means device base and null components mean unknown.
Computed joint/hand frames come from models, without duplicate declarations.
Additional fixed frames may name computed parents. Joint feedback omits
`frame_poses`; live FK uses measured positions without clamping. Velocity feedback
omits global pose; world relationships require explicit frame estimates.

Poses use `[x,y,z,qx,qy,qz,qw]` in metres with unit xyzw quaternions. See the
[core control API](../packages/core/README.md#device-calls-and-control) for FK/IK,
frame conversion and quaternion validation.

## Drivers

Drivers adapt SDKs, simulator APIs or services to the type's operations. They own
connections, unit conversion, boundary validation and cleanup. Declare implemented
operations in `access.driver.actions`:

- Every driver provides `load`, `unload`, `status` and `read`.
- Actuators add `write` and `stop`; joint/hand drivers add declared FK/IK,
  with FK also required for declared finger geometry.
- World drivers add `wait`; model drivers add their declared inference operations.

### Transport and lifecycle

Persistent drivers run with `--serve` and exchange JSONL requests and responses,
echoing each request's `id`. One-shot drivers consume one `{action,args}` request
on stdin and release temporary clients before exiting. Keep diagnostics on stderr;
stdout carries the protocol. The Python `kinex.driver_protocol.run` helper supports
both forms, including cancellation and cleanup.

`load` acquires resources and establishes readiness; `status` only observes.
Ordinary calls never restart failed services. Unload attempts capture shutdown,
stop and resource release. Cleanup terminates owned processes and closes borrowed
clients without terminating shared services. Runtime discovery and Python setup
follow the [overview's lifecycle rules](overview.md#runtime-discovery-and-lifecycle).

Public `error`, `code` and `details` survive direct, batch and Python calls without
exposing driver stderr; Python uses `RPCError`, a `RuntimeError` subclass.

### Motion and stop

Dispatch validates before admission and observes traffic. Writes are scheduled per
device; reads can overlap writes and independent devices write concurrently. Stop
bypasses approval, interrupts affected calls and clears queued writes within the
driver's declared operation-specific stop scope. Drivers keep reads and stop
responsive; uncertain writes are never retried.

Actuator writes submit validated buffers with `duration_s`, returning immediately
with `execution_id` and measured `state`. Gripper/suction actions are flat numeric
sequences; joint/hand actions are sequences of joint vectors. New writes replace
pending references without stopping; invalid writes leave them intact. Position
commands retain the final reference; velocity commands expire to zero velocity
while retaining posture. Background faults remain visible in reads. Verify arrival
through fresh feedback.

Ownership outlives submission: cleanup may stop only that invocation's remaining
motion, never another caller's replacement. Invalid post-submission feedback cancels
that submission before reporting failure. Failed cleanup reports `stop_failed`
and blocks further writes until recovery.

### Observations and capture

Observations and write-result states use finite numeric `timestamp` seconds in
the device clock: acquisition time, otherwise receipt time. Combined observations
use the latest component timestamp; cached data retains it. Timestamps carry no
clock label and are not implicitly synchronized. Cameras support `file`, `base64`
and `array` output with one timestamp for color/depth. Python reads default to
arrays; direct agent reads default to base64. Arrays cross JSON as encoded image
payloads and are decoded by Python; fixed dimensions are validated. Direct agent
reads attach RGB images in every mode, reusing encoded payloads or reading saved
files in the same call. Image data is sent as image content, not text.

Persistent drivers may implement `record_start` and `record_stop` for native
capture. Otherwise, recording samples through device dispatch. See
[recording](agent-integration.md#recording) for capture products and attribution.

## World: time and geometry

A `world` device gives tools access to the environment's clock. The supplied driver
uses real-world monotonic time; simulator drivers implement their own clock and
wait behavior. World has no `extrinsics`: its optional bounds, surfaces and local
frames are expressed in world coordinates. Bounds and surfaces are informational,
not enforced motion limits, and do not connect otherwise disconnected frame trees.

`world.read` returns `time_s` and optional `budget: {used_s, max_s}` in seconds;
used time is finite/nonnegative, allowance positive/finite or null for no cap.
Drivers own accounting; Kinex neither infers nor enforces a budget. Reads do not
advance time. `world.wait({duration_s})` returns `time_s` and actual `waited_s`;
concurrent waits share world time with individual cancellation.

Persistent waits use `access.driver.timeout_s` (default 60 seconds), allowing one
additional configured timeout for cancellation acknowledgement. Successful
recovery preserves the driver and reports `wait_timeout` without elapsed time;
failed recovery terminates it and requires explicit load. Caller cancellation
uses the same bounded recovery. Cancellation neither resets the world nor clears
actuator buffers: realtime continues; stepped simulation pauses without waits.

## Models: inference as a device

`model`, `detection` and `segmentation` represent inference services, with no
physical pose or `extrinsics`. A connection can be a local process using CPU,
CUDA or MPS, or a remote URL with credentials read from a named environment
variable. `read` and `status` report readiness without running inference.

Model intrinsics declare identity (`family`, optional `variant` and implementation
revision), artifacts and operations. Provision artifacts before activation;
runtime uses the declared paths without silently downloading a new checkpoint.
Each operation has a name and typed object inputs/outputs in Kinex's supported
JSON Schema subset. Dispatch validates both sides and rejects undeclared
operations and extra fields.

For example, a policy model returns action predictions. A controller tool such as
`run_policy` maps those predictions to actuator writes and owns motion and
termination. Inference itself does not command the robot.

`detection` and `segmentation` specialize this contract with
`detect({image, prompt, min_score?, max_results?})`. Results contain pixel boxes,
scores and labels; segmentation also requires a mask for each result. Boxes and
masks refer to the supplied image, not a fresh camera capture. These types supply
the canonical `detect` schema; profiles may add operations but cannot redefine it.
For example, `locate_object_3d` combines these results with camera depth.

See the [model guide](../packages/core/assets/builtin/device/templates/model/DEVICE.md)
for operation schemas and provisioning fields.

## Joints, grippers and hands

Joint goals are absolute, in model order and radians/metres; home is a joint-name
map. Returning to declared home permits a fixed 1° revolute recovery margin only
for an inward-moving prefix ending within limits. Measured starts are not clamped;
prismatic limits remain strict. Native controller bounds retain native saturation
when `limit_handling: native` is declared.

Gripper stop clears pending references while retaining the applied target and
preload, including direction-gripper accumulated targets. It never replaces a
loaded target with measured aperture; explicit open releases. Reset seeds from
measured posture, and stop before a first write must not close. Gripper feedback
reports aperture, faults and timestamp; finger measurements remain driver-private.
Hands use joint vectors and optional fingertip geometry whose chains name model
joints in traversal order. Fixed palm/grasp references are local frames; optional
weighted centers are geometric references, not contact feedback.

## Mobile and legged bases

`velocity` and `legged_base` are unlocalized roots: their profiles do not declare
`extrinsics.mount` or `pose_frame`. Relating them to world requires explicit frame
estimates. Command axes, units, feedback and stop behavior remain declared facts.

`legged_base` uses `mode` for writes and measured state, with declared write schema,
minimal skills and optional mode graph. Motion follows named-axis velocity,
optional posture and duration conventions. Drivers validate live prerequisites,
submit without waiting for physical completion and own replacement/cancellation.
Stand/crouch transitions may have limited interruption; guides declare that scope.

[Design index](README.md)

# Device contracts

A device is a named interface to hardware, a simulator or a computational service.
Its type selects physical/profile facts. Its extensible operation catalog declares
typed ROS topics and services, implemented by persistent nodes. See
[ROS communication](communication.md) for the runtime, Python and ownership
contracts. Remaining direct hardware drivers use the contracts documented below.

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
from these profiles; `.kinex/workspace.yaml` holds assembly identity and
workspace safety configuration. Runtime clock mode is not a workspace flag.

| Field | Contract |
| --- | --- |
| `name`, `type` | Device identity and the schema governing its interface. |
| `loaded` | Activation intent, not proof of a ready connection. Registration leaves devices unloaded; the model's `profile_write` tool preserves this intent. |
| `runtime`, `operations` | Explicit ROS environment, owned node factories and typed topic/service catalog. |
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

The world device supplies time. Geometric relationships may remain disconnected;
missing relationships are not identity transforms. Kinex publishes calibrated
fixed relationships from profiles and dynamic relationships from device models
and measured state; relative-pose calculations use tf2. A persistent arm
kinematics node exposes FK/IK using its URDF or serial-chain model. Simulators
supply state and measurements without owning the TF graph. Local frames declare `parent_frame`, `translation_m` and
`rotation_xyzw`; null parent means device base and null components mean unknown.
Computed joint/hand frames come from models, without duplicate declarations.
Additional fixed frames may name computed parents. Joint feedback omits
`frame_poses`; live FK uses measured positions without clamping. Velocity feedback
omits global pose; world relationships require explicit frame estimates.

Poses use `[x,y,z,qx,qy,qz,qw]` in metres with unit xyzw quaternions. See the
[core control API](../packages/core/README.md#device-calls-and-control) for FK/IK,
frame conversion and quaternion validation.

## Drivers

For new ROS integrations use `runtime` and `operations`. The following access
contract remains for hardware adapters that have not been ported to node factories.

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

Direct tools and Python use `deviceID`, `action` and `args` for device requests.
Python `device()` returns data fields directly, plus an optional `file`;
`devices(calls=[...])` returns a `results` array with per-entry `ok`, data or error.
Batch calls run concurrently under each device's scheduler and retain input
order; sampling is not simultaneous and effects are not atomic. See the
[core API](../packages/core/README.md#device-calls-and-control) for signatures.

### Motion and stop

Dispatch validates before admission and observes traffic. Writes are scheduled per
device; reads can overlap writes and independent devices write concurrently.
New writes supersede older pending commands on the same device. `device_stop`
and the trusted `/stop` command bypass approval; a direct model `device` call with
`action: stop` still requests `device_act`. Stop interrupts affected commands and
rejects queued writes within the driver's declared stop scope. Drivers keep reads
and stop responsive; uncertain writes are never retried.

Actuator writes submit validated buffers with `duration_s`, returning immediately
with `execution_id` and measured `state`. Gripper/suction actions are flat numeric
sequences; joint/hand actions are sequences of joint vectors. New writes replace
pending references without stopping; invalid writes leave them intact. Position
commands retain the final reference; velocity commands expire to zero velocity
while retaining posture. Background faults remain visible in reads. Verify arrival
through fresh feedback.

`servo` adds trajectory planning and, by default, waits the planned duration on
a loaded world clock. This wait does not verify arrival. `block=false` skips it
and requires no clock. Feedback loops in `exec` choose their own observation
intervals and stopping conditions; see [Python execution](tools-and-skills.md#python-execution-with-exec).

Ownership outlives submission: cleanup targets references still owned by that
invocation. Invalid post-submission feedback cancels
that submission before reporting failure. A failed dispatched stop or a driver
command reporting `stop_failed` blocks further writes until a successful load.

Python scripts and their composed tools share motion ownership. On controller
failure, timeout or cancellation, the runner attempts to stop remaining owned
motion; cleanup failures are logged while the original failure is returned.
Successful script completion may leave motion running. Use `stop_owned()` to
request a stop explicitly and receive any cleanup error. Ownership checks preserve
another invocation's replacement; the driver's declared physical stop scope still
applies.

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

Python reads retain image data for computation without automatically displaying
it. To return observations from `exec` or a Python tool, request files and pass
one path or an ordered list to `finish(result, file=...)`. Include camera identity
and acquisition timestamps in the result. Multiple captures remain separate
observations, even when returned together.

Continuous recording subscribes to declared topic operations. Explicit snapshots
use configured observations; capture does not invoke driver recording hooks. See
[recording](agent-integration.md#recording) for capture products and attribution.

## World: time and geometry

The ROS world exposes a Clock topic plus relative and absolute wait services.
Concurrent waits share progress; subscriptions and TF queries do not advance it.
Reset invalidates outstanding waits. See [world time](communication.md#world-time).

For direct hardware drivers, a `world` device gives tools access to the environment's clock. The supplied driver
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

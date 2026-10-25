# Device contracts

Devices bind named ROS topic/service operations to hardware, simulators or model
services. Core owns lifecycle, protocol execution and recording; setup owns
onboarding and calibration. See [communication](communication.md) for the wire
contract and Python API.

## Types

Builtin types are world, joint, gripper, suction, locomotion, rgb, rgbd, imu,
force_torque, model and other. Arms, lifts and dexterous hands are joint devices;
wheeled bases, quadrupeds and humanoid walking controllers are locomotion devices.
Their schemas validate physical facts, model structure, calibration and frames.
Each type guide recommends operation names and semantics for onboarding; Kinex
does not enforce them. `other` is the fallback when no type fits: it prescribes
no facts or operations, and its frames are optional for devices without spatial
meaning.

## Profiles

Each device lives at `.kinex/devices/<name>/profile.yaml` alongside owned node
sources and models. `description` is required and describes the device generally.
Each `operations.<name>.description` is also required and describes that operation
only: payload conventions, units, frames, timing, conditions and effects. Empty
strings are allowed; absent descriptions are invalid. Do not invent unknown facts.

`runtime` declares domain, namespace, optional SDK interpreter/overlays, owned
node factories, the snapshot `observation` and readiness timeout. `operations`
declares topic/service transport, direction, endpoint, ROS type, QoS and timeout.
Physical facts (`model`, `limits`, `color`, `frames`, etc.) are top-level fields
with typed validation. One device-level `source`, `method`, `calibrated_at` and
`needs_calibration` record covers calibration. `loaded` is lifecycle intent;
status reports live readiness. Unknown facts use `???`; null has only the
schema-defined meaning.

Readiness tracks two items per device. `access:<device>` is done once `runtime` is
declared; nodes own how hardware is reached, so `access.needs_calibration` only
records an explicit request against this item. `profile:<device>` is done when
typed facts are complete and non-root frame transforms are known. Loaded joint,
gripper, suction, locomotion and camera devices gate task readiness, and the
device inventory requires a world device.

Builtin DEVICE.md files are setup templates with profile examples; most ship
reference nodes beside them. They help authors write device/operation
descriptions and register nodes. They have no usage section, and no type or
instance usage text enters runtime context. Agents read descriptions directly
from profiles. Inside exec, `runtime.devices()` and `runtime.operations(name)`
provide discovery; `runtime.describe("device.operation")` resolves ROS payload
schemas when needed. These work on unloaded profiles and never start nodes.
Stable prompt prefixes do not change when descriptions, device catalogs or load
state change.

### Frames and poses

Every spatial device declares `frames.base`. Each frame explicitly names its
parent as `device:frame`; `parent: null` makes it an independent root and its
transform values are ignored. Omitting `parent` is invalid, including when the
parent would be the device's own base. For example:

```yaml
frames:
  base:
    parent: world:base
    translation_m: [0, 0, 0]
    rotation_xyzw: [0, 0, 0, 1]
  tcp:
    parent: arm:flange
    translation_m: [0, 0, 0.1]
    rotation_xyzw: [0, 0, 0, 1]
```

Non-root null transform components mean unknown, never identity. Kinex publishes
complete fixed edges to tf2. Joint and gripper geometry is a URDF: `model.base_link`
is the device base, and each link below it is a device frame named by the link,
published from measured joint state, mimic joints included, by the template
`links.py` node. Profile frames may use a link as a parent but must not reuse its
name. References must exist and be acyclic. ROS IDs use `device/frame`;
`kinex.helpers.lookup_transform` accepts these IDs or qualified `device:frame`
references. Query at observation stamps. Simulator nodes supply measurements and
state; they do not own Kinex frame publication.

Camera projection and distortion live in profile `color`/`depth`, not TF.
Native RGB-D profiles declare `color` and `depth` frames and resolve
depth-to-color geometry through tf2. Model devices have no frames.
Calibration procedures write top-level facts and `frames.<name>`, using
`profile:<device>` readiness items.

## Nodes

A device may own multiple node factories or bind a subset of a shared node's
operations. Empty `runtime.nodes` binds external endpoints; it does not create an
implicit mock. Factories receive `(profile, context)` and return owned rclpy nodes.
Relay implementation lives in node source, not the public operation catalog.
Nodes take their ROS names from `kinex.node.node_name(profile)`. Reference nodes
read vendor topics with sensor-data QoS, which matches publishers of any
reliability and durability; Kinex operations keep their declared QoS.

### Transport and lifecycle

`load`, `unload`, `status` are reserved host operations. Load waits for readiness,
status observes, and unload stops/reclaims owned resources. Definition changes
require unload, validation and reload. Discovery never initializes Python or ROS.
Agent device calls require host permission; Python cannot change lifecycle.
Normal operations never restart a failed node. Stop/disposal never kill borrowed
services.

### Motion and stop

Commands are standard ROS messages; a node validates each before replacing the
active command and logs rejections. Sending is distinct from measured arrival.
Anything that moves declares a `stop`, which must be a `std_srvs/srv/Trigger`
service; validation requires one for joint, gripper, suction and locomotion
devices with command topics and for worlds with `wait`. Abort, timeout and failure
stop the devices an invocation commanded; successful completion need not stop
motion, and scripts call a device's `stop` explicitly when it should. Host stop is
available without approval and cancels invocations commanding the device.
Physical stop behavior and scope must be documented on the device's stop
operation; actuator profiles also record them as `stop.behavior` (`hold`, `halt`
or `controller_emergency_stop`) and `stop.affected_devices`, which includes the
device itself.

### Observations and recording

Operations retain typed payloads and acquisition stamps. Recording subscribes to
selected declared topics and saves rosbag2, world time and TF. It never advances
time. Explicit snapshots read `runtime.observation`; a camera without one reads its
image and, for rgbd, the equally stamped depth, and other devices fall back to
their first joint state, image or clock output. Recorder deactivation precedes
device unload; disposal finalizes recordings. Model recording is opt-in.

## World: time and geometry

Every workspace requires one world device per ROS domain. Its required `time`
clock is the world time of device nodes, tf2 lookup and recording; `wait` is
recommended with the `stop` that cancels it, and `reset` only for simulators.
Waits are sequential. Physical workspaces keep real-world time with the template
node; a simulator, such as one run by
[rosbridge](https://github.com/stacx-lab/rosbridge), relays its own. Bounds and
surfaces are informational facts. Document pacing, epoch resets and terminal
episode behavior on each relevant operation. Workflow loops use world time rather
than a simulator-specific timer.

## Models: inference as a device

Persistent inference services are `model` devices; detection, segmentation and
policies are models too. The type prescribes no operations or payloads: model
operations are `kinex_interfaces/srv/Json` services exchanging JSON objects, and
each operation description defines their fields, coordinates and limitations.
Images pass as file paths. Profiles record family, artifacts and `compute`
placement. Load places the model and unload releases it with the device process.

## Joints and end effectors

A joint device commands the URDF's independent movable joints in document order,
with strict or native limit handling; `helpers.joint_model` computes FK and IK
from the URDF, and `tip_link` is the default end-effector link. A hand has no tip
link. A gripper's `grip` names the actuated joint with its open and closed
positions, and `frames.tcp` is the grasp point with +z approach. A suction tool
has no URDF: `vacuum` says whether it switches on and off or accepts a level,
`frames.tcp` is the cup contact centre, and its stop never releases a held object.
Policy values in [-1, 1] release at -1 and grip at +1 for both.
Guides recommend a `sensor_msgs/msg/JointState` `joint_state` and a
`trajectory_msgs/msg/JointTrajectory` `joint_target` for joint devices, and a
`std_msgs/msg/Float64` `target` with a `std_msgs/msg/Bool` `grasped` for end
effectors. No typed fact implies a mandatory operation or supplies a default
payload.

## Locomotion

A locomotion device declares its commandable body `velocity` axes, optional
`posture` offsets from the nominal stance, `strict` or `native` limits and its
`modes`: a state machine in which each mode lists the operations it accepts and
the modes it can be commanded to. Velocity follows the latest twist until a
watchdog timeout in world time, so callers re-send it; posture and mode commands
persist; a stop zeroes velocity without leaving the mode. Mode-specific inputs are
ordinary operations, JSON `std_msgs/msg/String` topics when they move the body.
Devices remain unlocalized roots: odometry drifts and is never a global pose.

## Cameras and sensors

Cameras publish `image` (`rgb8`) and, for rgbd, `depth` (`16UC1` in
`scale_m_per_unit`, 0 for missing samples) from one acquisition with equal stamps,
in calibrated optical frames. Readers subscribe and take the next frame; a
simulator publishes a current frame to each new subscriber with reliable QoS, so
reading a paused world never advances it. IMU and force/torque nodes publish
`sensor_msgs/msg/Imu` or `geometry_msgs/msg/WrenchStamped` in `<device>/base`
with the profile `bias` already subtracted, so consumers never correct samples;
unmeasured axes are NaN, never 0. An optional force/torque `zero` service
re-zeros at the current load until unload without changing the profile.

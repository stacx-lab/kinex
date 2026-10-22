# Device contracts

Devices bind named ROS topic/service operations to hardware, simulators or model
services. Core owns lifecycle, protocol execution and recording; setup owns
onboarding and calibration. See [communication](communication.md) for the wire
contract and Python API.

## Types

Builtin types remain: world, joint, dexterous_hand, gripper, suction, velocity,
legged_base, rgb, rgbd, imu, force_torque, model and other.
Their schemas validate physical facts, model structure, calibration and frames.
Each type guide recommends operation names and semantics for onboarding; Kinex
does not enforce them.

## Profiles

Each device lives at `.kinex/devices/<name>/profile.yaml` alongside owned node
sources and models. `description` is required and describes the device generally.
Each `operations.<name>.description` is also required and describes that operation
only: payload conventions, units, frames, timing, conditions and effects. Empty
strings are allowed; absent descriptions are invalid. Do not invent unknown facts.

`runtime` declares domain, namespace, optional SDK interpreter/overlays, owned
node factories and readiness timeout. `operations` declares topic/service
transport, direction, endpoint, ROS type, QoS and any ownership/cancellation
metadata. Physical facts (`model`, `control`, `color`, `frames`, etc.) are top-level
fields with typed validation. One device-level `source`, `method`, `calibrated_at`
and `needs_calibration` record covers calibration. `loaded` is lifecycle intent; status reports live
readiness. Unknown facts use `???`; null has only the schema-defined meaning.

Builtin DEVICE.md files are setup templates, including profile examples. They
help authors write device/operation descriptions and register nodes. Their Use
sections are removed; no type or instance usage text enters runtime context.
Agents read descriptions directly from profiles. Inside exec, `runtime.devices()`
and `runtime.operations(name)` provide discovery; `runtime.describe("device.operation")`
resolves ROS payload schemas when needed. These work on unloaded profiles and
never start nodes. Stable prompt prefixes do not change when descriptions,
device catalogs or load state change.

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
  flange:
    parent: arm:base
    translation_m: null
    rotation_xyzw: null
```

Non-root null transform components mean unknown, never identity. Kinex publishes
complete fixed edges to tf2. Model frames are explicitly declared with null
components; kinematics nodes supply their transforms from measured joint state.
References must exist and be acyclic. ROS IDs use `device/frame`; inherent
`kinex.helpers.lookup_transform` accepts these IDs or qualified `device:frame` references.
Query at observation stamps. Simulator nodes supply measurements and state;
they do not own Kinex frame publication.

Camera projection and distortion live in profile `color`/`depth`, not TF.
Native RGB-D profiles declare `color` and `depth` frames and resolve
depth-to-color geometry through tf2. A model service needs no spatial frames.
Calibration procedures write top-level facts and `frames.<name>`, using
`profile:<device>` readiness items.

## Nodes

A device may own multiple node factories or bind a subset of a shared node's
operations. Empty `runtime.nodes` binds external endpoints; it does not create an
implicit mock. Factories receive `(profile, context)` and return owned rclpy nodes.
Relay implementation lives in node source, not the public operation catalog.
Legacy JSONL `access.driver` execution and in-memory mocks are unsupported.
Historical driver/provisioning files remain on disk without runtime support.

### Transport and lifecycle

`load`, `unload`, `status` are reserved host operations. Load waits for readiness,
status observes, and unload stops/reclaims owned resources. Definition changes
require unload, validation and reload. Discovery never initializes Python or ROS.
Model operations require host permission; Python cannot change lifecycle.
Normal operations never restart a failed node. Stop/disposal never kill borrowed
services. Explicit action names replace implicit read/write adapters.

### Motion and stop

Managed motion declares Acquire/Stop/CommandStatus endpoints. Publications carry
owner, generation and command ID. Validate before replacing commands; delayed
older generations cannot take back ownership. Acceptance is distinct from measured
arrival. Abort, timeout and failure clean up only the invocation's owned commands
and requests; successful completion need not stop motion. `stop_owned()` explicitly
stops owned motion. Unconditional host stop is available without approval.
Physical stop behavior and scope must be documented on the device's stop operation.

### Observations and capture

Operations retain typed payloads and acquisition stamps. Recording subscribes to
selected declared topics and saves rosbag2, world time and TF. It never advances
time. Explicit snapshots use the configured observation. Recorder deactivation
precedes device unload; disposal finalizes recordings. Model recording is opt-in.

## World: time and geometry

Every workspace requires one world device per ROS domain. Its `time` clock is the
world time of device nodes, tf2 lookup and recording; `wait` and simulator-only
`reset` are recommended. Physical workspaces use the real-world clock. Bounds and
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
Declare cancellation for long-running owner-scoped services.

## Joints, grippers and hands

Joint models validate limits, model order and local frames. FK/IK are operations
provided by nodes when available. A gripper's geometry is a URDF: Kinex publishes
its links on TF from measured joint states, mimic joints included, and `grip`
names the actuated joint with its open and closed positions. `frames.tcp` is the
grasp point with +z approach. Hand models validate finger references and optional
center geometry.
No typed fact implies a mandatory operation or supplies a default payload.

## Mobile and legged bases

Profiles retain verified modes, SDK skills, response, limits and stop scopes.
Devices remain unlocalized roots unless supported by measured localization.
Describe units, coordinate frames, expiry and command semantics on each operation.

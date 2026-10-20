# Device contracts

Devices bind named ROS topic/service operations to hardware, simulators or model
services. Core owns lifecycle, protocol execution and recording; setup owns
onboarding and calibration. See [communication](communication.md) for the wire
contract and Python API.

## Types

Builtin types remain: world, joint, dexterous_hand, gripper, suction, velocity,
legged_base, rgb, rgbd, imu, force_torque, model, detection, segmentation and other.
Their schemas validate physical facts, model structure, calibration and frames.
They do not prescribe public operation names. Two devices of the same type can
expose entirely different operations.

## Profiles

Each device lives at `.kinex/devices/<name>/profile.yaml` alongside owned node
sources and models. `description` is required and describes the device generally.
Each `operations.<name>.description` is also required and describes that operation
only: payload conventions, units, frames, timing, conditions and effects. Empty
strings are allowed; absent descriptions are invalid. Do not invent unknown facts.

`runtime` declares domain, namespace, optional SDK interpreter/overlays, owned
node factories and readiness timeout. `operations` declares topic/service
transport, direction, endpoint, ROS type, QoS and any ownership/cancellation
metadata. `intrinsics`, `extrinsics`, access provenance and calibration markers
retain typed schema validation. `loaded` is lifecycle intent; status reports live
readiness. Unknown facts use `???`; null has only the schema-defined meaning.

Builtin DEVICE.md files are setup templates, including profile examples. They
help authors write device/operation descriptions and register nodes. Their Use
sections are removed; no type or instance usage text enters runtime context.
Agents query `runtime.devices()`, `runtime.device(name)`,
`runtime.operations(name)` and `runtime.describe("device.operation")` inside exec.
These work on unloaded profiles and never start nodes. Stable prompt prefixes do
not change when descriptions, device catalogs or load state change.

### Frames and poses

Extrinsics place the device base in a parent frame. A device can declare several
local frames in `intrinsics.frames`, with validated parent references and acyclic
relationships. Null transform components mean unknown, never identity. Kinex
publishes known fixed transforms to tf2. Kinematics nodes derive moving frames
from measured joint state and the model. Query transforms at observation stamps.
Simulators supply measurements and state; they do not own Kinex frame publication.
Camera intrinsics use CameraInfo, not TF.

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

The world device owns clock/wait semantics. Bounds and surfaces are informational
facts. Document pacing, epoch resets and terminal episode behavior on each relevant
operation. Workflow loops use world time rather than a simulator-specific timer.

## Models: inference as a device

Persistent inference services are devices. Their operation descriptions explain
inputs, output coordinates and limitations. Typed model facts and schemas remain
validated. Declare cancellation for long-running owner-scoped services.

## Joints, grippers and hands

Joint models validate limits, model order and local frames. FK/IK are operations
provided by nodes when available. Grippers retain geometry, aperture and control
facts; actual command polarity and hold/release behavior belong in their operation
descriptions. Hand models validate finger references and optional center geometry.
No typed fact implies a mandatory operation or supplies a default payload.

## Mobile and legged bases

Profiles retain verified modes, SDK skills, response, limits and stop scopes.
Devices remain unlocalized roots unless supported by measured localization.
Describe units, coordinate frames, expiry and command semantics on each operation.

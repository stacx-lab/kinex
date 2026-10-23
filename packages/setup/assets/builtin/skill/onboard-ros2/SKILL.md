---
name: onboard-ros2
description: Register ROS 2 devices with typed topic/service operations, explicit environments and measured interface checks.
---

# Onboard ROS 2 devices

Follow `/onboarding` and core's `setup-device` skill. Core owns communication,
node supervision and runtime Python. Setup owns provisioning and calibration.
Persistent model services are devices alongside sensors and actuators.

## Device definitions

Keep physical facts and calibration in `profile.yaml`. Select the builtin type
and validate its schema. Add a required device `description` for general identity,
capabilities and limitations. Each operation also requires its own `description`
for units, frames, timing, inputs/outputs and behavior; either may be empty.
Read descriptions directly from `profile.yaml`; use `runtime.describe` for ROS
payload schemas when needed. Add `runtime` with a domain and optional node factories.
Default nodes inherit Kinex Python and its overlays. Declare an interpreter and
overlays only for a separate device SDK.
Each factory exports `create(profile, context)` and returns an owned rclpy node.
Core starts these nodes on load and closes them on unload.

Declare each operation's description, transport (`topic` or `service`), direction
(`input` or `output`, from the device perspective), endpoint, ROS type and bounded
QoS. Services are inputs. Use native message/service types and field mappings.
Do not introduce ROS actions or fixed read/write adapters for new integrations.

Reuse an existing external vendor stack by pointing operations at its endpoints
with `runtime.nodes: []`, without taking ownership of its processes. A device
can expose a subset of a shared node's endpoints or use multiple owned nodes.
Stop and unload must never terminate a borrowed service. For owned implementations,
keep node sources next to the profile and register each factory in `runtime.nodes`.
If a relay is needed, implement it in those node sources; relay routes do not
belong in the public operation catalog. A node may define `async def ready(self)`
to check its dependencies within the host's readiness deadline.

`load`, `unload` and `status` are built-in lifecycle operations. Declare a stop
service for actuators. Managed motion uses core's `Acquire`, `Stop` and
`CommandStatus` interfaces and commands carrying owner, generation and command ID.
Validate replacements before accepting ownership. Old generations and retired
owners cannot regain control through delayed commands.

Every workspace requires a world device for time and waits; physical workspaces
use the real-world clock. Factories inherit its clock configuration
through their ROS context. Do not add workflow timers or simulator switches to
workspace.yaml. Execution mode belongs to the world implementation.

Unload before changing runtime definitions, validate the profile, then explicitly
reload. Inspect the compact operation catalog and test services and streams before
recording readiness. Return observations to the caller; do not create local
setup-progress files.

## Frames and cameras

Kinex automatically publishes known fixed profile transforms on `/tf_static`.
Joint devices and grippers register the template `links.py` node, which publishes
their URDF links from measured joint states on `/tf`; FK and IK come from the URDF
through `helpers.joint_model`. Kinex supplies persistent tf2 lookup. Simulators supply measurements
and state without publishing TF. Declare frames at the profile top level with explicit
`parent: device:frame`, or `parent: null` for an independent root. Mounts are
`frames.base`. ROS base IDs use `<device>/base`; all other local IDs use
`<device>/<frame>`. Match camera payload frame IDs to their calibrated
frames. Use tf2 at observation timestamps; missing calibration must not produce
identity transforms.

Camera intrinsics live in the profile. Establish raw versus rectified image
space and compare a source's live calibration with profile facts. Apply measured
calibration updates through `profile_write`. One source capture should
serve all subscribers, with bounded queues for slow consumers.

## Environment and verification

Prefer compatible installed vendor packages, then packaged binaries. Inspect
installed packages after sourcing the intended ROS distribution and overlays;
an unsourced shell does not establish whether a dependency exists. Build vendor
source only for an unsupported capability/version or an explicit user choice.

Configure `.kinex/kinex.json` with `python.provider: "ros-jazzy"` and
`python.interfaces` containing required ROS interface source directories (relative
to `.kinex`). The first approved exec prepares the independent Kinex Pixi/RoboStack
environment and builds core and configured interfaces. Verify rclpy,
tf2, generated type support and rosbag2 in that environment. Simulators keep their
own dependency environment; exec, helpers and recording always use Kinex Python.
Keep overlays local to owned subprocesses; do not activate ROS or `.kinex/python`
in ordinary shells. Discover device/operation contracts through `kinex.runtime`
inside exec, and return only the information needed for the current task.

Match the device's ROS domain and middleware configuration. Test bounded stream
queues, service failures, explicit stopping and owned-node teardown. Exercise
concurrent world waits and verify that a failed invocation cannot stop a newer
replacement command. Keep hardware motion within the task's approved scope.

---
name: setup-device
description: Add a device or repair its ROS nodes — choose an instance or type guide, provision its runtime, fill a profile and verify the interface.
resolves: access:world,access:locomotion,access:joint,access:gripper,access:suction,access:rgb,access:rgbd,access:imu,access:force_torque,access:model,profile:model,access:other
---

# Set up a device

Resolve the configured name and builtin type from user facts. In the ordered
Device guide roots, search all `<root>/<name>/DEVICE.md` paths before the first
`<root>/templates/<type>/DEVICE.md`. Read Setup and start from its Profile YAML.
Type guides recommend operation names and semantics; implement those the device
supports. Schemas validate only physical facts and calibration. Every workspace
requires a world device.

Use the nearest `.kinex/` in this directory or its ancestors. Store the profile
and owned node sources in `.kinex/devices/<name>/`; shared code may use `.kinex/lib/`.
Write a required `description` on the device for identity, capabilities and
limitations. Write a required `operations.<name>.description` for each operation's
inputs, outputs, units, frames, timing, errors and side effects. Empty strings are
allowed; do not invent facts. Read descriptions directly from `profile.yaml`.
Do not create
instance DEVICE.md usage sections.

Define each operation with transport, direction, endpoint, native ROS type and
bounded QoS; do not introduce ROS actions. Services are inputs. Use the type guide's names for recommended operations
and name others after the actual node. `load`, `unload` and
`status` are reserved host verbs. Commands use standard message types; anything
that moves, and a world with `wait`, declares a `std_srvs/srv/Trigger` `stop`,
served after the command subscriptions (`kinex.node.command_service` does).
Describe exact command semantics on each operation, including replacement and
expiry behavior. Nodes enforce only the device's own velocity limits (vendor,
controller or URDF); never add speed scaling or clamps beyond them unless the
user chose the value.

For owned ROS implementations, register factories in `runtime.nodes`, each with
`entry` and `factory`. Factories receive `(profile, context)` and return an owned
rclpy node named with `kinex.node.node_name(profile)`, since device names may hold
characters ROS rejects. A device may have several nodes or expose a subset of a shared node's
endpoints. For borrowed nodes use `runtime.nodes: []`; never stop their processes.
A node may define `async def ready(self)` to check its dependencies within
`runtime.ready_timeout_s`.
Keep reads and stop responsive and make cleanup release every owned resource even
when another cleanup step fails. Lifecycle belongs to the host; Python tools
cannot load or unload devices.

Nodes that adapt a vendor driver read its topics with sensor-data QoS, which
matches publishers of any reliability and durability; Kinex operations keep their
declared QoS. Match the device's ROS domain and middleware configuration.

Nodes inherit the independent Kinex Python environment. Set `runtime.interpreter`
and overlays only when a device SDK needs its own environment. For ROS, set
`python.provider: "ros-jazzy"` and `python.interfaces` (interface source
directories) in `.kinex/kinex.json`; the first approved exec prepares it, then
verify rclpy, tf2, message type support and rosbag2 there. Never activate it in an
ordinary shell. Prefer official vendor SDKs: installed packages first, then
binaries, building from source only when needed; check what is installed after
sourcing the intended ROS distribution. Keep credentials in the environment.

Use `profile_write` to validate and preserve typed facts/provenance. Leave unknown
facts as `???`, mark missing calibration and clear resolved requests with
`needs_calibration: null`. New devices stay unloaded. Kinex publishes known static
frames; URDF link publishers publish measured moving frames. Kinex owns tf2 lookup
(`kinex.helpers.lookup_transform`); devices never serve it.
When a simulator has a robot catalog, export that catalog as the source of truth
for its nodes and operation descriptions; type guides do not reproduce a
particular simulator.
Keep task metadata and benchmark judges outside the agent device graph.

Validate schema, imports and syntax before activation. Load through the host only
within the authorized task scope, inspect readiness and verify the declared
operations. Test input rejection, stop and teardown. Unload
before editing node/runtime definitions, then validate and explicitly reload.

### Profile facts and frames

Write physical facts directly at the top level: `model`, `home`, `limits`, `grip`,
`color`, `depth`, `frames`, etc. Do not write intrinsics/extrinsics wrappers.
Use one top-level calibration record (`source`, `method`, `calibrated_at`,
`needs_calibration`); readiness uses `profile:<device>` and `access:<device>`.
Every spatial device declares `frames.base`. Every frame explicitly supplies
`parent: device:frame` or `parent: null` for an independent root. There is no
implicit base parent. Root transform values are ignored; write null components.
For non-roots, translation_m and rotation_xyzw describe the parent-relative edge;
??? components mean unknown and publish no static TF. URDF links of joint and
gripper devices are frames under their base, named by link, whose live transforms
come from measured joint states; parents may reference them, and profile frames
must not reuse their names. Parent references must exist and be acyclic.

Unknown profile facts use ???; null means explicitly absent or inapplicable, never lack of evidence. Keep required structural fields valid; do not invent a root frame when its attachment is unknown. Explicitly absent channels, no additional limits and open bounds may use null. Calibration timestamps may be null when no calibration has occurred; needs_calibration:null clears a resolved marker.

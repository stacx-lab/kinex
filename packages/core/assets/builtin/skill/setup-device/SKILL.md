---
name: setup-device
description: Add a device or repair its ROS nodes — choose an instance or type guide, provision its runtime, fill a profile and verify the interface.
resolves: access:world,access:velocity,access:legged_base,access:joint,access:gripper,access:suction,access:rgb,access:rgbd,access:imu,access:force_torque,access:model,profile:model,access:other
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

Define each operation with transport, direction, endpoint, ROS type and bounded
QoS. Services are inputs. Use the type guide's names for recommended operations
and name others after the actual node. `load`, `unload` and
`status` are reserved host verbs. Declare a stop service for managed motion and
its Acquire/Stop/CommandStatus ownership endpoints. Describe exact command
semantics on that operation, including replacement and expiry behavior.

For owned ROS implementations, register factories in `runtime.nodes`, each with
`entry` and `factory`. Factories receive `(profile, context)` and return an owned
rclpy node. A device may have several nodes or expose a subset of a shared node's
endpoints. For borrowed nodes use `runtime.nodes: []`; never stop their processes.
Keep reads and stop responsive and make cleanup release every owned resource even
when another cleanup step fails. Lifecycle belongs to the host; Python tools
cannot load or unload devices. Legacy JSONL drivers and implicit mocks are not
supported, including the old shipped driver scaffolds.

Nodes inherit the independent Kinex Python environment. Set `runtime.interpreter`
and overlays only when a device SDK needs its own environment. Configure ROS
interface sources and prepare Kinex Python explicitly; discovery must not create
an environment or activate one in an ordinary shell. Keep credentials in the
environment. Prefer official vendor SDKs and inspect their documentation.

Use `profile_write` to validate and preserve typed facts/provenance. Leave unknown
facts as `???`, mark missing calibration and clear resolved requests with
`needs_calibration: null`. New devices stay unloaded. Kinex publishes known static
frames; URDF link publishers publish measured moving frames. Use world time and the `kinex.helpers.lookup_transform` helper; do not expose
transform lookup as a device operation or register a world frame-graph factory.
When a simulator has a robot catalog, export that catalog as the source of truth
for its nodes and operation descriptions; type guides do not reproduce a
particular simulator.
Keep task metadata and benchmark judges outside the agent device graph.

Validate schema, imports and syntax before activation. Load through the host only
within the authorized task scope, inspect readiness and verify the declared
operations. Test input rejection, ownership, cancellation and teardown. Unload
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
null components mean unknown and publish no static TF. URDF links of joint and
gripper devices are frames under their base, named by link, whose live transforms
come from measured joint states; parents may reference them, and profile frames
must not reuse their names. Parent references must exist and be acyclic.

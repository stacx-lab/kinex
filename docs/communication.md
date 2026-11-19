# ROS operations and Python workflows

Core owns operational ROS infrastructure and device supervision. Setup owns
onboarding and calibration procedures. A device profile retains typed physical
facts and adds `runtime` and `operations`. Core does not import ROS during
discovery or activate Python in ordinary shells.

## Device definition

```yaml
name: camera
description: Fixed scene camera with calibrated optical frame
type: rgb
layout: mono
loaded: false
runtime:
  domain_id: 0
  nodes:
    - {entry: node.py, factory: create}
operations:
  image:
    description: Calibrated color stream
    transport: topic
    direction: output
    endpoint: /kinex/camera/image
    type: sensor_msgs/msg/Image
    qos: {depth: 1, reliability: best_effort, durability: volatile}
```

Device nodes default to the workspace Kinex Python and its overlays;
`runtime.overlays` scripts are sourced after them, for example to put a
device-local SDK directory on `PYTHONPATH`. Only a device that needs a separate
SDK environment declares `runtime.interpreter`, which replaces Kinex Python and
its overlays; that environment never selects the Python used by exec, the lib or
recording.

The example shows runtime fields; a complete profile also includes top-level
physical facts, explicit frames and calibration metadata. Direction is from the
device's perspective. A service is an input. A topic can be an input or output.
`qos` defaults to depth 1, `reliable` and `volatile`; `timeout_s` (default 10)
bounds a request, a publish's subscriber discovery and a snapshot read. Operations
describe the public communication interface; implementation details such as relay
routes belong in node source files, not the operation catalog.

`runtime.nodes` explicitly lists the nodes Kinex starts and owns. A factory
receives `(profile, rclpy_context)` and returns an owned rclpy node. Multiple
factories can implement one device. With `nodes: []`, the device binds to existing
endpoints without starting an implementation node. Several devices can expose
different operations from the same external node; none owns that shared process.
The host maintains its own communication client for readiness and control.

Factories may expose `async def ready(self)` to check their own dependencies.
The host awaits these checks and public endpoint discovery within
`runtime.ready_timeout_s`, on both load and status. Node constructors should
create resources without waiting for callbacks; the host adds the returned nodes
to its executor before checking readiness.

Builtin type templates ship reference `node.py` files that adapt an existing ROS
driver: they read vendor topics with sensor-data QoS and publish or serve the
public endpoints. Their source routes are implementation details. Kinex remaps
each device node's `/clock` to the world `time` topic; the world template's clock
node disables global ROS arguments so it is never remapped into its own output.
Workspaces exported by [rosbridge](https://github.com/stacx-lab/rosbridge) borrow
the simulator graph's endpoints and declare no nodes of their own.

`load`, `unload` and `status` are host lifecycle operations, not declared ROS
operations; profiles cannot declare them. `stop` calls the declared
`std_srvs/srv/Trigger` service, or is a no-op for a passive device. Actuators with
command topics and worlds with `wait` must declare one. Loading checks interface
readiness; normal calls never restart failed nodes.

Unload before changing definitions. Core fingerprints runtime fields, profile
facts, node entrypoint source and the URDF; changed definitions require explicit
reload. Read device and operation descriptions directly from profiles. Discovery
remains read-only. A program imports `runtime` from `kinex`: use
`runtime.devices()` for configured devices and host-known readiness,
`runtime.device(name)` for one device's description and state,
`runtime.operations(device)` for declared operations (including unloaded devices),
and `runtime.describe("device.operation")` for protocol metadata and recursive
ROS payload definitions. These queries never load devices or advance time.
Catalogs stay in Python unless the program finishes with them; they are not
injected into the system prompt or exported as per-operation model tools.
The host TypeScript API retains `runtime.devices.operations()`.

Device and operation descriptions are required strings and may be empty. Typed
templates guide setup; they recommend operation names without enforcing them and
inject no usage text.

## Kinex Python

Exec, the function library, ROS clients, tf2 and recording always use `.kinex/python`.
It defaults to ROS Jazzy; configure `.kinex/kinex.json` for Humble (`ros-humble`),
plain uv (`uv`) or extra interfaces:

```json
{"python": {"provider": "ros-jazzy", "interfaces": ["../../vendor/ros/interfaces"]}}
```

Interface source paths resolve relative to `.kinex`. Hosts prepare it explicitly
with the TypeScript `runtime.python.prepare()`, which installs the independent
Pixi/RoboStack Python 3.12 environment for the selected distribution (`ros-jazzy`
or `ros-humble`) and builds core and configured interfaces there. The provider is
selected from workspace configuration,
independent of device load state. Discovery does not install or create an
environment. First approved use prepares a missing environment, or one whose
distribution or interface sources changed; explicit preparation always runs, and each preparation
rebuilds the interfaces from clean.
ROS processes source only their own overlays; host shells remain unchanged.
A simulator, such as
one run by [rosbridge](https://github.com/stacx-lab/rosbridge), keeps its own
Python and communicates with Kinex through ROS; simulator packages are not
installed in Kinex Python. `exec` has no interpreter
option.

## Async communication

```python
import asyncio
from kinex import finish, io

async def main():
    state = io.subscribe("arm.joint_state", depth=1)
    sample = await state.next(timeout_s=2)
    # Payload fields follow the declared ROS types; Json operations
    # exchange plain objects described by the operation.
    response = await io.request("model.infer", image=image_path)
    await io.publish("arm.joint_target", target_message)
    await io.request("world.wait", duration_s=0.05)
    finish({"summary": "selected result"})

asyncio.run(main())
```

This is an exec program. `image_path` and `target_message` above are application
inputs. Python reaches devices only through `kinex.communication`. exec owns one
scope per invocation, `io`, opened on first use inside the program's event loop
and released when the program ends, so a program runs one `asyncio.run(main())`;
programs and library functions import it with `from kinex import io` and take no
scope parameter. `io.read(operation)`
takes the next message of an output topic. A standalone client outside exec
enters `async with communication(catalog) as io`, which makes its scope the
active one for the library functions it calls. A `custom_interfaces/srv/Json`
operation encodes keyword arguments as one JSON object and returns the decoded
response object; owned nodes serve it with
`kinex.node.json_service(node, operation, handler)`. `publish`, `subscribe`,
`request` and `serve` are protocol primitives; they do not prescribe
control flow. Use ordinary functions, branching and asyncio task groups.
Messages may be native ROS messages or field mappings; see [values](#values) for
what a mapping may hold. A subscription used with
`with` or `async with` closes on exit; the scope closes any others. `finish`
converts ROS messages, poses and NumPy values in its result to JSON and non-finite
numbers to `null`; images are attached only through its `file`. Subscriptions expose
`next`, `latest(max_age_s=...)` and idempotent `close`. Both ROS and Python queues
are bounded. Receipt-age checks detect transport staleness; observation timestamps
belong to world time.

`io.serve({endpoint, type}, handler)` hosts a temporary async service. Its endpoint
must be under `io.namespace + "/"`. Handlers and communication resources
are removed when the scope closes. Persistent services belong to device nodes.

Reusable code is a public function of a `kinex.lib` module, builtin or in a
workspace's `.kinex/lib`. Library functions share the invocation's scope and
cleanup, call each other as ordinary functions and have no persistent lifecycle; see
[programs and the library](tools-and-skills.md#programs-and-the-library-exec-and-lib).

The `kinex` package separates audiences. The root and `kinex.lib` (browsed with
the `lib` tool) are the exec API; `kinex.node` serves device node
authors; `kinex.common` holds shared internals and `kinex.host` the processes the
runtime launches.

## Values

A value has one form in each of three places, and Kinex converts at the two
boundaries between them; a program does not.

| | In a program | Written down: results, arguments, profiles | On the wire |
| --- | --- | --- | --- |
| Vector | NumPy array | list of numbers | the declared ROS array field |
| Pose | scipy `RigidTransform` | `[x, y, z, qx, qy, qz, qw]` | `Pose`, `Transform` |
| Time | seconds on the world clock | seconds | `Time`, `Duration` |
| Frame | `device:frame` or `device/frame` | the same | `frame_id` |

Operations carry the ROS types their profile declares; Kinex defines no message
format of its own, and `io.read` and subscriptions return native messages.
Library functions take a value in any equivalent form and return it in one: a
vector may be a list, a tuple, a message's array field or an array; a pose may be
a `RigidTransform`, its seven numbers or a `Pose`, `Transform`, `PoseStamped` or
`TransformStamped`; a time may be seconds, a stamp or a stamped message.
`pose(value)` and `seconds(value)`, imported from `kinex`, make these conversions
for a program's own use.

`io.publish` and `io.request` encode a field mapping by each field's declared
type: seconds for a `Time` or `Duration`, a pose for a `Pose` or `Transform`, one
`RigidTransform` holding several poses for an array of them, numbers for a
`Point`, `Vector3` or `Quaternion`, and arrays for numeric fields. The mapping
is read, never changed. A program's result writes poses as their seven numbers
and times as seconds; `kinex.plain(value)` gives that JSON-ready form to a
program that writes a file of its own.

```python
state = await io.read("arm.joint_state")
arm = lib.kinematics.joint_model("arm")
flange = arm.fk(state.position)                       # the message's array, as it is
tcp = flange * pose([0, 0, 0.1, 0, 0, 0, 1])          # poses compose as objects
seen = await lib.frames.lookup_transform("arm:base", "camera:color", image) * found
await io.publish("arm.joint_target", {"joint_names": arm.names, "points": [
    {"positions": arm.ik(seen, state.position), "time_from_start": 2.0}]})
```

## World time

A world provides the required `time` clock and, as recommended, relative
`wait(duration_s)` with its `stop`; only simulators add `reset`. A zero wait is an
observation barrier. Waits are sequential: the world rejects a wait while another
is pending, and `stop` cancels the pending one. Realtime waits observe progress;
stepped waits authorize world advancement. A periodic loop must skip missed
deadlines, and must not assume an expired wait produces a fresh observation.

Subscriptions, TF lookup and calibration sampling never advance the world.
Host watchdogs use monotonic wall time so timeouts and cancellation still work
when the world is paused. World reset interrupts waits and invalidates cached
time-dependent observations.

A service rejection raises `kinex.OperationError`. Its `operation`, `interface`,
raw `response` and serializable `details` survive error reporting. Catch an
expected terminal wait inside the same communication scope, inspect its response,
and inspect measurements at or after the returned `time_s`. Benchmark judging
belongs to the environment operator, not device operations. A rejected wait
alone does not establish success. Other failures must propagate. Create and
validate all subscriptions before creating their `next()` coroutines so a missing
operation cannot leave unawaited coroutines.

## Commands and cleanup

Command topics use standard ROS message types, such as
`trajectory_msgs/msg/JointTrajectory`, `trajectory_msgs/msg/MultiDOFJointTrajectory`
(tip link poses), `std_msgs/msg/Float64`, `geometry_msgs/msg/Twist` and
`std_msgs/msg/String` (JSON for free-form commands); the operation description is
their contract. `publish` sends one
message once a subscriber is matched; sending does not establish physical arrival.
Device nodes validate each command and log rejections. Owned nodes serve their
inputs and the Trigger `stop` with `kinex.node.command_service(node, operations,
commands, hold)`, where `commands` maps each operation to the function that
forwards its messages. A node serves `stop` after its command subscriptions:
`publish` discovers the device's `stop` first, so a command reaches the device
rather than only another subscriber such as a recorder.

One host approval covers a Python invocation and composed operations. Python
cannot load/unload devices. Explicit stop remains approval-free; model recording
is opt-in. This API is not a sandbox for arbitrary Python.

Before its first command to a device, a publish or a service request, an
invocation reports the device to the host. Successful completion leaves motion
running; before teardown, the scope waits for reliable subscribers to acknowledge
its commands, and an unacknowledged command fails it. Failure, cancellation or
timeout stops every device the invocation commanded, from the communication scope
and again from the host after the Python process ends; a wait abandoned inside a
scope stops its world. Any host stop of a device, through `device_stop`, `/stop`,
a device call's `stop` action or the runtime API, also cancels running
invocations that commanded it. Uncertain commands are not retried. Unload releases
owned nodes and stops according to the declared device contract, without
terminating borrowed services.

## Frames and images

Kinex owns frame publication and composition. Device load automatically publishes
known mounts and fixed internal frames from profiles on `/tf_static`; there is no
profile switch for this. Unknown calibration never becomes an identity transform.
Profiles declare their frames in top-level `frames`, including `frames.base`;
joint and gripper URDF links add device frames of their own. Every frame
explicitly supplies `parent: device:frame`, or `parent: null` for an independent
root whose transform values must be null (inapplicable). Non-root ??? components mean unknown
and publish no static edge. ROS frame IDs use `<device>/<frame>`, including
`arm/base`, `arm/flange` and `gripper/tcp`. Kinex lookup accepts either qualified
profile references (`arm:base`) or native ROS IDs (`arm/base`).

Loading a joint or gripper device whose profile has a complete URDF `model` and a
`joint_state` operation starts a link publisher beside its nodes
(`kinex.host.links`); profiles declare nothing for it. It reads the profile's URDF
once, subscribes to measured `joint_state`, and publishes every link below the base link as
`<device>/<link>`: fixed joints once on `/tf_static`, movable and mimic joints on
`/tf`. Measurements are never clamped to command limits, and each publication
retains the measurement timestamp. Dynamic TF retains the latest sample with
reliable, transient-local QoS so Kinex readers can join while the world is paused.

Kinematics need no device service. `lib.kinematics.joint_model(device)` loads the
resolved URDF: `fk(positions, link=None)` returns a link pose in `<device>/base`
as a `RigidTransform` and `ik(pose, seed, link=None)` runs the bounded solver within
URDF limits, verifies its result with FK and returns the positions as an array; the link defaults to the only `model.tip_links`
entry. A controller with native kinematics may declare `fk` or `ik` as ordinary
optional operations.

Kinex automatically owns a persistent tf2 service
(`custom_interfaces/srv/LookupTransform`) for each runtime ROS domain with a world
clock. Use
`await lib.frames.lookup_transform(target, source, stamp=None, timeout_s=5)`,
which returns the pose of `source` in `target` as a `RigidTransform`: multiplying it
by a pose or applying it to points seen in `source` expresses them in `target`. Its internal endpoint is passed to exec outside
the device catalog; no world operation or device factory registers it. The
service retains 120 s of world-time history, so a stamp from an earlier call
remains answerable; a standalone scope's local history keeps tf2's 10 s. A
world-clock rewind invalidates dynamic history while retaining fixed calibration.

The simulator supplies state and measurements, or node geometry descriptors, not TF or a transform-lookup
service. Camera nodes set image frame IDs to the calibrated optical frame.

`lib.frames.lookup_transform` uses tf2 and accepts qualified frame references or ROS frame IDs.
Supply `stamp`, in seconds or as the stamped message a measurement came in, for a
particular world time; omitting it explicitly requests the latest available transform. Kinex retains the tf2 service
across exec calls, so a new invocation can query a paused world without waiting
for another physics tick. Missing relationships and unavailable timestamps are
errors. A lookup waits its whole timeout, then names the cause: a frame not on TF
with the frames its device has published, an unloaded device, frames in
disconnected trees (a mount of unknown calibration publishes no edge), or the
time range tf2 holds.

Cameras are native ROS topics: `image`, `depth` for rgbd and, where a source
provides it, `camera_info`. Camera projection and distortion live in the profile,
or node geometry descriptors, not TF or `camera_info`.
`lib.images.camera_geometry(camera)` fetches the active descriptors once per
program; its `project` and `unproject` call the camera node's geometry services,
or compute locally only for explicitly undistorted pinhole profiles.
A stereo camera uses `left_image` and `right_image` with `left` and `right` geometry
streams; `lib.images.stereo_frame(camera)` reads both, and `camera_frame` takes `eye`.
`lib.images.camera_frame(camera)` subscribes and returns
the next image and, for rgbd, the depth with the same stamp; the same
`kinex.common.camera.frame` backs device snapshots and `lib.perception.locate_object_3d`. A live
camera streams; a simulator publishes a current frame to each new subscriber and
repeats it while paused, so a paused world can be read without advancing it.
Images stay as ROS payloads in Python. `lib.images.image_array` converts them for
computation and `lib.images.save_image` writes one to a file, for example to pass
to a model device. Pass an image to `finish(file=...)` to attach it for the model.

## Native validation

`custom_interfaces` defines only the `Json`, `Wait` and `LookupTransform`
services; commands and observations use standard ROS messages. The ROS
providers build it from `packages/core/assets/ros`; build that directory in any
other ROS environment that calls these services.
[rosbridge](https://github.com/stacx-lab/rosbridge) serves `Wait` and `Json`
from its own byte-identical copy of the package, so neither project needs the
other's checkout to build.

`rosbridge setup <robot> --directory DIR --domain-id N` exports a workspace whose
devices borrow the running graph's endpoints. Start the simulator with
`rosbridge launch <task> --execution-mode stepped|realtime --domain-id N`, then
load the devices on the same ROS domain.

## Recording

Continuous recording observes the selected operations, by default every declared
topic of the device, including input commands, and saves typed CDR messages with
rosbag2. Output sample rates use the world clock. Clock and TF data are retained
alongside the observations, with reset epochs in the sample index. Recording
never requests world progress. See [recording](agent-integration.md#recording)
for products and lifecycle. The Kinex Python environment must provide
`rosbag2_py` and SQLite storage; frame conversion additionally uses
`tf2_geometry_msgs`. Discovery imports neither.

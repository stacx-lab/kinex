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
its overlays; that environment never selects the Python used by exec, helpers or
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
the simulator graph's endpoints and start only the `links.py` nodes of joint and
gripper devices.

`load`, `unload` and `status` are host lifecycle operations, not declared ROS
operations; profiles cannot declare them. `stop` calls the declared
`std_srvs/srv/Trigger` service, or is a no-op for a passive device. Actuators with
command topics and worlds with `wait` must declare one. Loading checks interface
readiness; normal calls never restart failed nodes.

Unload before changing definitions. Core fingerprints runtime fields, profile
facts, node entrypoint source and the URDF; changed definitions require explicit
reload. Read device and operation descriptions directly from profiles. Discovery
remains read-only. Inside exec, use `from kinex import runtime`, then
`runtime.devices()` for configured devices and host-known readiness,
`runtime.device(name)` for one device's description and state,
`runtime.operations(device)` for declared operations (including unloaded devices),
and `runtime.describe("device.operation")` for protocol metadata and recursive
ROS payload definitions. These queries never load devices or advance time.
Catalogs stay in Python unless explicitly selected for `finish()`; they are not
injected into the system prompt or exported as per-operation model tools.
The host TypeScript API retains `runtime.devices.operations()`.

Device and operation descriptions are required strings and may be empty. Typed
templates guide setup; they recommend operation names without enforcing them and
inject no usage text.

## Kinex Python

Exec, helpers, ROS clients, tf2 and recording always use `.kinex/python`.
For ROS workspaces, configure `.kinex/kinex.json`:

```json
{"python": {"provider": "ros-jazzy", "interfaces": ["../../vendor/ros/interfaces"]}}
```

Interface source paths resolve relative to `.kinex`. Hosts prepare it explicitly
with the TypeScript `runtime.python.prepare()`, which installs the independent
Pixi/RoboStack Jazzy Python 3.12 environment and builds core and configured
interfaces there. The provider is selected from workspace configuration,
independent of device load state. Discovery does not install or create an
environment. First approved use prepares a missing environment, or one whose
interface sources changed; explicit preparation always runs, and each preparation
rebuilds the interfaces from clean.
ROS processes source only their own overlays; host shells remain unchanged.
Non-ROS workspaces default to the existing uv environment. A simulator, such as
one run by [rosbridge](https://github.com/stacx-lab/rosbridge), keeps its own
Python and communicates with Kinex through ROS; simulator packages are not
installed in Kinex Python. `exec` and Python tool manifests have no interpreter
option.

## Async communication

```python
import asyncio
from kinex import communication, finish

async def main():
    async with communication() as io:
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

`image_path` and `target_message` above are application inputs. Scripts and tools
reach devices only through `communication()`. A `kinex_interfaces/srv/Json`
operation encodes keyword arguments as one JSON object and returns the decoded
response object; owned nodes serve it with
`kinex.node.json_service(node, operation, handler)`. `publish`, `subscribe`,
`request` and `serve` are protocol primitives; the helpers do not prescribe
control flow. Use ordinary functions, branching and asyncio task groups.
Messages may be native ROS messages or field mappings. A subscription used with
`with` or `async with` closes on exit; the scope closes any others. `finish`
converts ROS messages and NumPy values to JSON and non-finite numbers to `null`;
images return only through `file=`. Subscriptions expose
`next`, `latest(max_age_s=...)` and idempotent `close`. Both ROS and Python queues
are bounded. Receipt-age checks detect transport staleness; observation timestamps
belong to world time.

`io.serve({endpoint, type}, handler)` hosts a temporary async service. Its endpoint
must be under `io.namespace + "/"`. Handlers and communication resources
are removed when the scope closes. Persistent services belong to device nodes.

Async tools declare `async: true` in `tool.yaml` and export
`async def main(args, io)`. Builtin tools are interfaces to `kinex.helpers`
functions of the same name and parameters; exec calls those helpers directly to
share its communication and cleanup. Workspace helpers live in `.kinex/lib`.
Standard script tools still use a script entrypoint. Neither form has a persistent
lifecycle.

The `kinex` package separates audiences. The root and `kinex.helpers` (indexed by
`kinex/helpers/helpers.txt`) are the exec API; `kinex.node` serves device node
authors; `kinex.lib` holds shared internals and `kinex.host` the processes the
runtime launches.

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
`trajectory_msgs/msg/JointTrajectory`, `std_msgs/msg/Float64`,
`geometry_msgs/msg/Twist` and `std_msgs/msg/String` (JSON for free-form
commands); the operation description is their contract. `publish` sends one
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
root whose transform values are ignored. Non-root null components mean unknown
and publish no static edge. ROS frame IDs use `<device>/<frame>`, including
`arm/base`, `arm/flange` and `gripper/tcp`. Kinex lookup accepts either qualified
profile references (`arm:base`) or native ROS IDs (`arm/base`).

A joint or gripper device's `links.py` factory creates a persistent
`kinex.node.LinkPublisher`. It reads the profile's URDF once, subscribes to
measured `joint_state`, and publishes every link below the base link as
`<device>/<link>`: fixed joints once on `/tf_static`, movable and mimic joints on
`/tf`. Measurements are never clamped to command limits, and each publication
retains the measurement timestamp. Dynamic TF retains the latest sample with
reliable, transient-local QoS so Kinex readers can join while the world is paused.

Kinematics need no device service. `helpers.joint_model(device)` loads the
resolved URDF: `fk(positions, link=None)` returns a link pose in `<device>/base`
and `ik(pose, seed, link=None)` runs the bounded solver within URDF limits and
verifies its result with FK; the link defaults to `model.tip_link`. A controller
with native kinematics may declare `fk` or `ik` as ordinary optional operations.

Kinex automatically owns a persistent tf2 service
(`kinex_interfaces/srv/LookupTransform`) for each runtime ROS domain with a world
clock. Import `helpers` from `kinex` and use
`await helpers.lookup_transform(io, target, source, stamp=None, timeout_s=5)`,
which returns `TransformStamped`. Its internal endpoint is passed to exec outside
the device catalog; no world operation or device factory registers it. A
world-clock rewind invalidates dynamic history while retaining fixed calibration.

The simulator supplies state and measurements, not TF or a transform-lookup
service. Camera nodes set image frame IDs to the calibrated optical frame.

`relative_pose` uses tf2 and accepts qualified frame references or ROS frame IDs.
Supply `timestamp` for a measurement at a particular world time; omitting it
explicitly requests the latest available transform. Kinex retains the tf2 service
across exec calls, so a new invocation can query a paused world without waiting
for another physics tick. Missing relationships and unavailable timestamps are
errors.

Cameras are native ROS topics: `image`, `depth` for rgbd and, where a source
provides it, `camera_info`. Camera projection and distortion live in the profile,
not TF or `camera_info`. `helpers.camera_frame(io, camera)` subscribes and returns
the next image and, for rgbd, the depth with the same stamp; the same
`kinex.lib.camera.frame` backs device snapshots and `locate_object_3d`. A live
camera streams; a simulator publishes a current frame to each new subscriber, so
a paused world can be read without advancing it. Images stay as ROS payloads in
Python. `helpers.image_array` converts them for computation; `helpers.save_image`
writes a selected image. Return paths with `finish(result, file=...)` after
leaving the scope to attach images to the model.

## Native validation

`kinex_interfaces` defines only the `Json`, `Wait` and `LookupTransform`
services; commands and observations use standard ROS messages. The ros-jazzy
provider builds it from `packages/core/assets/ros`; build that directory in any
other ROS environment that calls these services.
[rosbridge](https://github.com/stacx-lab/rosbridge) serves
`kinex_interfaces/srv/Wait` from its own byte-identical copy, so it needs no Kinex
checkout to build.

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

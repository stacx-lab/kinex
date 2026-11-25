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
device's perspective. A service or an action is an input. A topic can be an input or output.
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
public endpoints. Their source routes are implementation details. A domain with a
world device runs its device nodes on the world's time, the domain's `/clock`; the
world template's node disables global ROS arguments so it never follows its own clock.
Workspaces exported by [kinex-sim](https://github.com/stacx-lab/kinex-sim) borrow
the simulator graph's endpoints and declare no nodes of their own.

`load`, `unload` and `status` are host lifecycle operations, not declared ROS
operations; profiles cannot declare them. `stop` calls the declared
`std_srvs/srv/Trigger` service, or is a no-op for a passive device. Actuators with
command topics and worlds, for their waits, must declare one. Loading checks interface
readiness; normal calls never restart failed nodes.

Unload before changing definitions. Core fingerprints runtime fields, profile
facts, node entrypoint source and the URDF; changed definitions require explicit
reload. Read device and operation descriptions directly from profiles. Discovery
remains read-only. A program imports `runtime` from `kinex`: use
`runtime.devices()` for configured devices and host-known readiness,
`runtime.device(name)` for one device's description and state,
`runtime.operations(device)` for declared operations (including unloaded devices;
both take a name or an entry of `runtime.devices()`),
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
one run by [kinex-sim](https://github.com/stacx-lab/kinex-sim), keeps its own
Python and communicates with Kinex through ROS; simulator packages are not
installed in Kinex Python. `exec` has no interpreter
option.

## The Python runtime

ROS is the communication layer; a program's control flow runs on asyncio. Kinex keeps one
Python runtime for each ROS domain of a workspace, started on first use and kept between
programs. It holds what is slow to make: the interpreter with its imported libraries, the
ROS node whose discovery of the graph is complete, the clients and publishers of the
loaded devices' operations, the world's clock, and the tf2 history. The host
tells it when a device's nodes come up or go away, so its catalog is always the loaded
devices.

An exec program attaches to it. The program is run as `__main__` in a thread of its own,
with a scope on the runtime's bridge: its event loop, its topic subscriptions, the goals
it sent, the devices it commanded and its world waits. A subscription is made when the
program first reads its topic, which is fast on a node that already knows the graph, and
ends with the program: a simulator renders a camera only for its subscribers, so a
subscription kept between programs would cost every step. Each program gets the library
and its own helper modules as they are on disk; installed packages stay imported. The
runtime runs one program at a time. The exec boundary is unchanged by this: see
[commands and cleanup](#commands-and-cleanup). A program that does not end when it is
cancelled is ended with its runtime, and the next program starts another; device nodes
live in their own processes and are not affected.

Each device also has a host process of its own, in Kinex Python or in the interpreter
its profile names. It owns the device's nodes and answers the host's own calls: readiness,
the device tool's reads, requests and commands, and `stop`, which therefore works
whatever a program is doing.

## Devices in a program

```python
import asyncio
from kinex import device, finish, world

async def main():
    arm = device("arm")
    states = arm.topic("joint_state")
    sample = await states.next()
    # Payload fields follow the declared ROS types; Json operations
    # exchange plain objects described by the operation.
    response = await device("model").service("infer")(image=image_path)
    await arm.topic("joint_target").publish(target_message)
    await world.wait(0.05)
    finish({"summary": "selected result"})

asyncio.run(main())
```

This is an exec program. `image_path` and `target_message` above are application
inputs. Python reaches devices only through `kinex.communication`, whose scope a program
reaches as `device` and `world`, imported from `kinex`; library functions use the same
ones and take no scope parameter. A scope binds to the program's event loop at the first
thing the program awaits through it, so a program runs one `asyncio.run(main())` and may
name its devices before it. A standalone client outside exec enters
`async with communication(catalog) as io`, which gives it a bridge of its own and makes
its scope the active one for the library functions it calls; `io.device(name)` and
`io.world` are its devices and its world.

`device(name)` is a loaded device, reached through the operations its profile declares:

| Operation | In a program |
| --- | --- |
| Output topic | `topic = device.topic(name)`; `await topic.next()`, `topic.latest`, `async for message in topic`, `topic.close()` |
| Input topic | `await device.topic(name).publish(message)` |
| Service | `await device.service(name)(**fields)` |
| Action | `goal = device.action(name)(**fields)` sends it; `await goal` waits for its end and gives its result; `goal.status`, `goal.feedback`, `goal.result`, `await goal.cancel()` |

Using an operation as another transport raises `TypeError`, and one the loaded devices do
not declare raises `RPCError`. These are protocol primitives; they do not prescribe
control flow. Use ordinary functions, branching and asyncio task groups. Messages may be
native ROS messages or field mappings; see [values](#values) for what a mapping may hold.

A topic object is the same one each time a program asks for it. `next()` gives the next
unread message, bounded by the operation's `timeout_s`. On a topic that retains its last
message (`transient_local`), `next()` with nothing unread subscribes again and is sent
that message, so a paused world can be read twice. `latest` is the last message received,
without waiting. Both ROS and Python queues are bounded; `depth` on `topic(name, depth=…)`
sets how many unread messages a program keeps. Reading never advances world time.

A `custom_interfaces/srv/Json` operation encodes keyword arguments as one JSON object and
returns the decoded response object; owned nodes serve it with
`kinex.node.json_service(node, operation, handler)`.

Calling an action sends its goal, a message or field mapping or its fields by name, and
returns the `Goal` at once; sending advances no world time. Awaiting the goal waits on
the world until it has ended and gives its result; one the device rejects, aborts or
cancels raises `RPCError`, with the result in its details. `goal.status` is `sending`,
`executing`, then `succeeded`, `canceled`, `aborted` or `rejected`; `goal.feedback` is the
latest the device sent and `goal.result` the action's result once it has ended. A
`custom_interfaces/action/Json` action is the free-form one, as the Json service is: its
goal's fields travel as one JSON object, poses and arrays converted as `finish` converts
them, and its feedback and result are the decoded objects. Goals of several devices run
at once:

```python
left = device("left_arm").action("move")(pose=left_pose, profile="precision")
right = device("right_arm").action("move")(pose=right_pose)
await asyncio.gather(left, right)  # until both have ended
print(left.status, left.result["position_error_m"])
```

`finish` converts ROS messages, poses and NumPy values in its result to JSON and
non-finite numbers to `null`; images are attached only through its `file`.

Reusable code is a public function of a `kinex.lib` module, builtin or in a
workspace's `.kinex/lib`. Library functions share the program's scope and
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
format of its own, and topics return native messages.
Library functions take a value in any equivalent form and return it in one: a
vector may be a list, a tuple, a message's array field or an array; a pose may be
a `RigidTransform`, its seven numbers or a `Pose`, `Transform`, `PoseStamped` or
`TransformStamped`; a time may be seconds, a stamp or a stamped message.
`pose(value)` and `seconds(value)`, imported from `kinex`, make these conversions
for a program's own use.

A topic's `publish`, a service and an action encode a field mapping by each field's declared
type: seconds for a `Time` or `Duration`, a pose for a `Pose` or `Transform`, one
`RigidTransform` holding several poses for an array of them, numbers for a
`Point`, `Vector3` or `Quaternion`, and arrays for numeric fields. The mapping
is read, never changed. A program's result writes poses as their seven numbers
and times as seconds; `kinex.plain(value)` gives that JSON-ready form to a
program that writes a file of its own.

```python
state = await device("arm").topic("joint_state").next()
arm = lib.kinematics.joint_model("arm")
flange = arm.fk(state.position)                       # the message's array, as it is
tcp = flange * pose([0, 0, 0.1, 0, 0, 0, 1])          # poses compose as objects
seen = await lib.frames.lookup_transform("arm:base", "camera:color", image) * found
await device("arm").topic("joint_target").publish({"joint_names": arm.names, "points": [
    {"positions": arm.ik(seen, state.position), "time_from_start": 2.0}]})
```

## World time

The world device is the only clock. Every world declares the same operations, whether
it is the real world, a simulator running in realtime or a stepped simulator, and a
program holds them as `world`:

| Operation | In a program | What it does |
| --- | --- | --- |
| `now` | `await world.now()` | `(time_s, used_s, max_s)`: world time, and the time budget in seconds of world time, `None` where the world has none |
| `wait` | `await world.wait(seconds)` | wait seconds of world time; returns the world time reached |
| `stop` | none: Kinex calls it | cancel the pending wait |

`await` means "wait until it is done", and the world decides whether time passes
meanwhile. A message or a reply needs none. Two things do: `world.wait(seconds)`, and
a goal, which a program awaits to wait for its end. `world.wait(0)` is a barrier that
lets no time pass. The real world and a realtime simulator have no budget; a stepped
simulator may have one.

Waits combine as asyncio's awaitables do. `asyncio.gather(left_goal, right_goal)`
waits for both arms; tasks that each await their own goals in turn run two sequences
side by side; `asyncio.wait(..., return_when=FIRST_COMPLETED)` over a goal and
`world.wait(2)` takes whichever is first, after which the program cancels the wait
that lost, or the world would run on for it. asyncio's own timeouts and `asyncio.sleep`
count wall time, which a stepped world does not follow: wait on the world.

`async for now in world.rate(hz)` ticks on absolute deadlines, made of the same
waits; a tick whose time has passed is skipped. Loops at different rates are ordinary
tasks:

```python
async def control(arm, hz, policy):
    states, commands = arm.topic("joint_state"), arm.topic("joint_target")
    await states.next()
    async for now in world.rate(hz):
        await commands.publish(policy(states.latest))

await asyncio.gather(control(device("left_arm"), 20, left_policy), control(device("right_arm"), 10, right_policy))
```

What differs between worlds is only whether time passes by itself:

- **The real world and a realtime simulator.** The world always runs, and a wait only
  blocks the program until its time, or its goal, is over.
- **A stepped simulator.** Time has checkpoints: the simulator advances only while a
  program waits, and is paused otherwise.

A world admits one wait at a time, while a program's tasks may wait at once. One
driver in the program's scope therefore turns what its tasks wait for into a single
request at a time: it reads `now`, then asks `wait` for the seconds to the earliest
time any task waits for, and for infinite seconds when they await goals alone. A world
that executes goals ends the wait on the step one ends at, and names it. The reply is a
checkpoint, at which the tasks it concerns resume, and the next request follows only
once they are waiting again. So several tasks share one world and none advances it on
its own. The world also rests while a command, a request or a goal is on its way to its
device, and while a tick's body runs; before each request the driver waits until the
commands sent so far are acknowledged. A message or a reply never advances time.

`wait` is `custom_interfaces/srv/Wait`: `seconds` of world time, and a reply with
`time_s` and `ended`, the ids of the goals that have ended since the world's previous
reply, where the world executes goals. Infinite seconds wait for a goal's end alone: a
world that executes none returns at once, so a goal that ends elsewhere, in the real
world or in a device outside a simulator, costs no simulated time, and the driver
stops the wait when the goal's own result arrives. `now` is
`custom_interfaces/srv/Now`, replying `time_s`, `used_s` and `max_s`, NaN without a
budget and `max_s` infinite without a cap. `stop` cancels the pending wait: the driver
stops a wait when what the program waits for changes, and when the program abandons
it. A world may end a wait early, unsuccessfully, when a device refuses a command or
stops a motion it cannot execute: the reply says why and where it got to, a stepped
world never advances the rest, and every task waiting on the world raises
`kinex.OperationError`, so a script learns of the refusal at once. Other failures of
the wait reach the same tasks. The budget can include initialization, so it is not
world time; Kinex reports it as supplied and never enforces it.

The model sees these operations in the world's profile and may call them through the
device tool as declared, such as `wait` with `{"seconds": 1.0}`. A world also
publishes its time on the domain's `/clock`, the ROS clock that device nodes, tf2
history and recording follow; it is not an operation. A world has no reset: an
episode starts with its world, and a clock that starts again, as a new simulator
run's does, invalidates what was observed before it.

Subscriptions, TF lookup and calibration sampling never advance the world.
Host watchdogs use monotonic wall time so timeouts and cancellation still work
when the world is paused.

A service rejection raises `kinex.OperationError`. Its `operation`, `interface`,
raw `response` and serializable `details` survive error reporting. Benchmark judging
belongs to the environment operator, not device operations. A wait that ended early
does not establish success. Other failures must propagate.

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

Before its first command to a device, a publish, a service request or a goal, a
program reports the device to the host. Successful completion leaves motion
running; before its scope is released, it waits for reliable subscribers to acknowledge
its commands, and an unacknowledged command fails it. Failure, cancellation or
timeout stops every device the program commanded, from its scope and again from the
host once the program has ended; a wait abandoned inside a scope stops its world.
Releasing a scope ends the program's subscriptions and the processes it left running,
and leaves the runtime's clients as they were. A program that does not end within a
second of its cancellation is ended with its runtime, and the host stops its devices. Any host stop of a device, through `device_stop`, `/stop`,
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

IK searches near the seed, so it never answers with a distant posture. When that
search fails, a bounded probe from seeds spread over the joint ranges (and the
declared home) explains why in `kinex.lib.kinematics.IKError`, a `ValueError`:
`details.reason` is `posture_change` (reachable only from a distant posture, given
as `details.alternative_joints` with its `travel_rad`), `out_of_reach` or `not_found`.
IK never returns that posture: a program plans the joint move to it deliberately. `free_axis` leaves rotation about a link-frame axis free, such as a
gripper's approach axis, and `position_only` ignores rotation.
`lib.motion.cartesian(model, start, poses, period_s)` plans straight tool paths for
approaching, retracting and lifting: local IK solves each waypoint from the previous one,
a jump between waypoints raises `IKError` with reason `discontinuity`, and the plan is
timed by the same limits as `lib.motion.trajectory`.

The runtime of each ROS domain keeps the domain's tf2 history. Use
`await lib.frames.lookup_transform(target, source, stamp=None, timeout_s=5)`,
which returns the pose of `source` in `target` as a `RigidTransform`: multiplying it
by a pose or applying it to points seen in `source` expresses them in `target`. The
runtime keeps 120 s of world-time history across programs, so a stamp from an earlier
program remains answerable; a standalone scope's own history keeps tf2's 10 s. A
world-clock rewind invalidates dynamic history while retaining fixed calibration.

The simulator supplies state and measurements, or node geometry descriptors, not TF or a transform-lookup
service. Camera nodes set image frame IDs to the calibrated optical frame.

`lib.frames.lookup_transform` uses tf2 and accepts qualified frame references or ROS frame IDs.
Supply `stamp`, in seconds or as the stamped message a measurement came in, for a
particular world time; omitting it explicitly requests the latest available transform. The runtime listens
between programs, so a new program can query a paused world without waiting
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
`kinex.common.camera.frame` backs device snapshots. A live
camera streams; a simulator publishes a current frame to each new subscriber and
repeats it while paused, so a paused world can be read without advancing it.
Images stay as ROS payloads in Python. `lib.images.image_array` converts them for
computation and `lib.images.save_image` writes one to a file, for example to pass
to a model device. Pass an image to `finish(file=...)` to attach it for the model.

## Native validation

`custom_interfaces` defines only the `Json`, `Now` and `Wait`
services; commands and observations use standard ROS messages, and actions standard
ROS actions such as those of `control_msgs`, which Kinex Python installs. The ROS
providers build it from `packages/core/assets/ros`; build that directory in any
other ROS environment that calls these services.
[kinex-sim](https://github.com/stacx-lab/kinex-sim) serves `Wait` and `Json`
from its own byte-identical copy of the package, so neither project needs the
other's checkout to build.

`kinex-sim setup <task> --directory DIR --domain-id N` exports that task's
workspace, whose devices borrow the running graph's endpoints. Start the task with
`kinex-sim launch <task> --execution-mode stepped|realtime --domain-id N` on the
same ROS domain, then open Kinex, which loads the exported devices when it starts.

## Recording

Continuous recording observes the selected operations, by default every declared
topic of the device, including input commands, and saves typed CDR messages with
rosbag2. Output sample rates use the world clock. Clock and TF data are retained
alongside the observations, with reset epochs in the sample index. Recording
never requests world progress. See [recording](agent-integration.md#recording)
for products and lifecycle. The Kinex Python environment must provide
`rosbag2_py` and SQLite storage; frame conversion additionally uses
`tf2_geometry_msgs`. Discovery imports neither.

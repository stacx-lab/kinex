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

Device nodes default to the workspace Kinex Python and its overlays. Only a device
that needs a separate SDK environment declares `runtime.interpreter` and
`runtime.overlays`; that environment never selects the Python used by exec,
helpers or recording.

The example shows runtime fields; a complete profile also includes intrinsics,
extrinsics and metadata. Direction is from the device's perspective. A service
is an input. A topic can be an input or output. Operations describe the public
communication interface; implementation details such as relay routes belong in
node source files, not the operation catalog.

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

The LIBERO catalog supplies explicit `node.py` implementations for its devices.
Those files create subscriptions, publishers and service clients/servers to
forward between the public endpoints and the external simulator. Their source
routes are implementation details. The clock relay disables inherited ROS
arguments so `/clock` keeps its literal source name and cannot be remapped into
its own output. Other nodes normally inherit the world clock configuration.

`load`, `unload` and `status` are host lifecycle operations, not declared ROS
operations. `stop` calls the declared service, or is a no-op for a passive
device. Profiles with managed motion must declare a stop service. Loading checks
interface readiness; normal calls never restart failed nodes.

Unload before changing definitions. Core fingerprints runtime fields, profile
facts and node entrypoint source; changed definitions require explicit reload.
Discovery remains read-only. Inside exec, use `from kinex import runtime`, then
`runtime.devices()` for configured devices and host-known readiness,
`runtime.device(name)` for the general device description,
`runtime.operations(device)` for declared operations (including unloaded devices),
and `runtime.describe("device.operation")` for protocol metadata and recursive
ROS payload definitions. These queries never load devices or advance time.
Catalogs stay in Python unless explicitly selected for `finish()`; they are not
injected into the system prompt or exported as per-operation model tools.
The host TypeScript API retains `runtime.devices.operations()`.

Device and operation descriptions are required strings and may be empty. Typed
templates guide setup; they do not prescribe operation names or inject usage text.
Legacy JSONL drivers and in-memory mock execution are unsupported.

## Kinex Python

Exec, helpers, ROS clients, tf2 and recording always use `.kinex/python`.
For ROS workspaces, configure `.kinex/kinex.json`:

```json
{"python": {"provider": "ros-jazzy", "interfaces": ["../../vendor/ros/interfaces"]}}
```

Interface source paths resolve relative to `.kinex`. Explicit preparation with
`await runtime.python.prepare()` installs the independent Pixi/RoboStack Jazzy
Python 3.12 environment and builds core and configured interfaces there. The
provider is selected from workspace configuration, independent of device load
state. Discovery does not install or create an environment. First approved use
prepares a missing environment; explicit preparation also rebuilds interfaces.
ROS processes source only their own overlays; host shells remain unchanged.
Non-ROS workspaces default to the existing uv environment. A simulator keeps its
own Python and communicates with Kinex through ROS; simulator packages are not
installed in Kinex Python. `exec.interpreter` and Python tool manifest interpreter
overrides are rejected with migration guidance.

## Async communication

```python
import asyncio
from kinex import communication, finish

async def main():
    async with communication() as io:
        state = io.subscribe("arm.joint_state", depth=1)
        sample = await state.next(timeout_s=2)
        # Payload fields follow the declared ROS message/service types.
        response = await io.request("model.infer", image=image)
        await io.publish("arm.joint_target", target_message)
        await io.request("world.wait", duration_s=0.05)
    finish({"summary": "selected result"})

asyncio.run(main())
```

`image` and `target_message` above are application inputs. `publish`, `subscribe`,
`request` and `serve` are protocol primitives; the helpers do not prescribe
control flow. Use ordinary functions, branching and asyncio task groups.
Messages may be native ROS messages or field mappings. Subscriptions expose
`next`, `latest(max_age_s=...)` and idempotent `close`. Both ROS and Python queues
are bounded. Receipt-age checks detect transport staleness; observation timestamps
belong to world time.

`io.serve({endpoint, type}, handler)` hosts a temporary async service. Its endpoint
must be under `io.namespace + "/"`. Handlers and communication resources
are removed when the scope closes. Persistent services belong to device nodes.

Async tools declare `async: true` in `tool.yaml` and export
`async def main(args, io)`. Compose them using
`from kinex.ros_tools import call` and `await call("servo", **arguments)`.
Composed tools share the invocation context. Standard script tools still use a
script entrypoint. Neither form has a persistent lifecycle.

## World time

The loaded world device provides `time`, `wait(duration_s)` and
`wait_until(until_s)`. Realtime waits observe progress; stepped waits authorize
shared world advancement. Concurrent waits do not sum their durations. Past
absolute deadlines return immediately. A periodic loop must skip missed
deadlines, and must not assume an expired wait produces a fresh observation.

Subscriptions, TF lookup and calibration sampling never advance the world.
Host watchdogs use monotonic wall time so timeouts and cancellation still work
when the world is paused. World reset interrupts waits and invalidates cached
time-dependent observations.

A service rejection raises `kinex.OperationError`. Its `operation`, `interface`,
raw `response` and serializable `details` survive error reporting. Catch an
expected terminal wait inside the same communication scope, inspect its response,
and read official task status at or after the returned `time_s`. A rejected wait
alone does not establish success. Other failures must propagate. Create and
validate all subscriptions before creating their `next()` coroutines so a missing
operation cannot leave unawaited coroutines.

## Motion and supervision

A motion input topic declares `motion: {acquire, stop, status}` endpoints using
the core `Acquire`, `Stop` and `CommandStatus` interfaces. The command type must
carry `owner`, `generation` and `command_id` fields. Kinex supplies these fields.
The accepting endpoint validates and atomically replaces ownership.

`publish` returns a command ID for managed motion. `await io.accepted(operation,
command_id)` observes its correlated acceptance. Acceptance does not establish
physical arrival. Ignored acceptance results are checked before scope completion.
Invalid commands do not replace previously accepted references.

One host approval covers a Python invocation and composed operations. Python
cannot load/unload devices. Explicit stop remains approval-free; model recording
is opt-in. This API is not a sandbox for arbitrary Python.

Successful scope completion preserves accepted motion. Failure, cancellation or
timeout conditionally stops remaining owned motion; newer replacements survive.
The host enrolls ownership before dispatch and cleans up after Python process
failure. Uncertain commands are not retried. Unload releases owned nodes and
stops according to the declared device contract, without terminating borrowed
services.

## Frames and images

Kinex owns frame publication and composition. Device load automatically publishes
known mounts and fixed internal frames from profiles on `/tf_static`; there is no
profile switch for this. Unknown calibration never becomes an identity transform.
The base frame is the device name, and local frames use `<device>/<frame>`, such
as `arm/flange` and `gripper/tcp`.

An arm's explicit `kinematics.py` factory creates a persistent
`kinex.ros_kinematics.KinematicsNode`. It reads the profile's URDF or serial-chain
model once, subscribes to measured `joint_state`, and publishes the modeled
endpoint on `/tf` through Kinex. Measurements are reordered by joint name and
are never clamped to command limits. Each publication retains the measurement
timestamp. Dynamic TF retains the latest sample with reliable, transient-local
QoS so Kinex readers can join while the world is paused.

The node exposes `fk` (`kinex_interfaces/srv/ForwardKinematics`) and optional
`ik` (`kinex_interfaces/srv/InverseKinematics`) services. FK takes joint positions
in model order; IK takes a pose and seed. Both accept device-local `frame` and
`reference_frame` names: empty means the modeled endpoint and device base,
respectively. IK uses the model's bounded solver, enforces limits and verifies
its result with FK. These services do not command motion.

The world declares a `frames.py` factory for `kinex.ros_frame_graph.FrameGraphNode`.
This Kinex-owned tf2 buffer serves `world.lookup_transform`. A world-clock rewind
invalidates dynamic history while retaining fixed calibration.

The simulator supplies state and measurements, not TF or a transform-lookup
service. LIBERO camera nodes map image and `CameraInfo` frame IDs to the calibrated
device base frame, including on-demand captures. Camera projection/distortion
uses `CameraInfo`; non-geometric properties remain in profiles.

`relative_pose` uses tf2 and ROS frame IDs. Supply `timestamp` for a measurement
at a particular world time; omitting it explicitly requests the latest available
transform. The world exposes a persistent tf2 lookup service, so a new
invocation can query a paused world without waiting for another physics tick.
Missing relationships and unavailable timestamps are errors.

Images stay as ROS payloads in Python. `kinex.ros_images.array` converts them for
computation; `save` writes a selected image. Return paths with
`finish(result, file=...)` after leaving the scope to attach images to the model.

## Native validation

Build the shared interface package from `packages/core/assets/ros` in the selected
ROS environment. For sibling rosbridge, set `KINEX_ROS_PACKAGES` to that directory
before `pixi run -e libero build`.

The sibling `workspace_libero` contains `demo.py`, `validate.py` and
`validate-host.mjs`, with external startup instructions in its README. The demo
uses a persistent deterministic model fixture and is a control demonstration,
not a trained policy or benchmark task solution.

## Recording

Continuous capture observes the selected device's declared topics, including
input commands, and saves typed CDR messages with rosbag2. Output sample rates
use the world clock. Clock and TF data are retained alongside the observations,
with reset epochs in the sample index. Capturing never requests world progress.
See [recording](agent-integration.md#recording) for products and lifecycle.
The Kinex Python environment must provide `rosbag2_py` and SQLite storage; frame
conversion additionally uses `tf2_geometry_msgs`. Discovery imports neither.

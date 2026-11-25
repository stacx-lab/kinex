"""Asyncio topics, requests and goals over ROS 2.

A Bridge is the ROS side: one context, node and executor thread, the world clock and the
clients of the catalog's operations. A Scope is one program's use of a bridge, bound to
that program's event loop: exec gives each program one, reached through `kinex.device`
and `kinex.world`; a standalone client enters communication() itself. Imports are inert,
and the world is the sole source of workflow timing.
"""
import asyncio
from collections import deque
import contextlib
import contextvars
import importlib
import json
from numbers import Real
import threading
import uuid
from kinex.common.geometry import vector
from kinex.common.plain import TIMES, ros_type
from kinex.errors import RPCError, OperationError

_active = contextvars.ContextVar("kinex_communication", default=None)
# Free-form operations carry JSON objects; their descriptions define the fields.
JSON = "custom_interfaces/srv/Json"
WAIT = "custom_interfaces/srv/Wait"
NOW = "custom_interfaces/srv/Now"
CLOCK = "rosgraph_msgs/msg/Clock"
# How a goal finished, by its action_msgs/msg/GoalStatus.
STATUS = {4: "succeeded", 5: "canceled", 6: "aborted"}


def duration(seconds):
    """A builtin_interfaces Duration or Time payload from seconds."""
    nanoseconds = round(seconds * 1e9)
    return {"sec": nanoseconds // 1_000_000_000, "nanosec": nanoseconds % 1_000_000_000}


def seconds(value):
    """Seconds from a number, a builtin_interfaces Time or Duration, or a stamped message."""
    if isinstance(value, Real) and not isinstance(value, bool):
        return float(value)
    stamp = getattr(getattr(value, "header", None), "stamp", value)
    return stamp.sec + stamp.nanosec / 1e9


# A pose's two parts under the names each message type gives them.
POSES = {"geometry_msgs/Pose": ("position", "orientation"), "geometry_msgs/Transform": ("translation", "rotation")}
VECTORS = {"geometry_msgs/Point": "xyz", "geometry_msgs/Vector3": "xyz", "geometry_msgs/Quaternion": "xyzw"}


def _fields(cls, value):
    """What to set cls from, built fresh so the caller keeps its own payload.

    A mapping names fields. One value may stand for a whole message: seconds for a time
    or duration, a pose in any form for a Pose or Transform, one batch of poses for an
    array of them, and numbers for a Point, Vector3 or Quaternion. Other leaves pass
    through as rosidl takes them.
    """
    if isinstance(value, cls):
        return value
    kind = ros_type(cls)
    if kind in TIMES and isinstance(value, Real) and not isinstance(value, bool):
        return duration(value)
    if kind in POSES and not isinstance(value, dict):
        from kinex.values import components
        x, y, z, qx, qy, qz, qw = components(value, single=True).tolist()
        where, turn = POSES[kind]
        return {where: {"x": x, "y": y, "z": z}, turn: {"x": qx, "y": qy, "z": qz, "w": qw}}
    if kind in VECTORS and not isinstance(value, dict):
        return dict(zip(VECTORS[kind], vector(value, len(VECTORS[kind]), cls.__name__)))
    if not isinstance(value, dict):
        raise TypeError(f"expected {cls.__name__} or field mapping")
    slots = dict(zip((name[1:] for name in getattr(cls, "__slots__", ())), getattr(cls, "SLOT_TYPES", ())))
    fields = {}
    for name, item in value.items():
        slot = slots.get(name)
        element = getattr(slot, "value_type", slot)
        if not hasattr(element, "namespaces"):
            fields[name] = item
            continue
        nested = getattr(importlib.import_module(".".join(element.namespaces)), element.name)
        if element is slot:
            fields[name] = _fields(nested, item)
        else:
            # A batch of poses is one RigidTransform holding several.
            entries = item if not hasattr(item, "as_components") else [item] if item.single else [item[index] for index in range(len(item))]
            fields[name] = [_fields(nested, entry) for entry in entries]
    return fields


def message_value(cls, value):
    from rosidl_runtime_py.set_message import set_message_fields
    fields = _fields(cls, value)
    if isinstance(fields, cls):
        return fields
    message = cls()
    set_message_fields(message, fields)
    return message


def qos(spec, depth=None):
    from rclpy.qos import QoSProfile, ReliabilityPolicy, DurabilityPolicy
    fields = spec.get("qos", {})
    size = depth if depth is not None else fields.get("depth", 1)
    if not isinstance(size, int) or isinstance(size, bool) or not 1 <= size <= 1024:
        raise ValueError("subscription depth must be in [1, 1024]")
    return QoSProfile(
        depth=size,
        reliability=(ReliabilityPolicy.BEST_EFFORT if fields.get("reliability") == "best_effort"
                     else ReliabilityPolicy.RELIABLE),
        durability=(DurabilityPolicy.TRANSIENT_LOCAL if fields.get("durability") == "transient_local"
                    else DurabilityPolicy.VOLATILE))


class Subscription:
    def __init__(self, scope, spec, depth):
        from rosidl_runtime_py.utilities import get_message
        self.scope, self.spec = scope, spec
        self.buffer = deque(maxlen=qos(spec, depth).depth)
        self.event = asyncio.Event()
        self.latest = None
        self.closed = False
        self.dropped = 0
        # A single scheduled delivery and bounded cross-thread inbox prevent
        # slow event-loop consumers from creating an unbounded callback queue.
        self.inbox = deque(maxlen=self.buffer.maxlen)
        self.lock = threading.Lock()
        self.scheduled = False
        self.handle = scope.bridge.node.create_subscription(
            get_message(spec["type"]), spec["endpoint"], self._receive, qos(spec, depth))

    def _receive(self, message):
        with self.lock:
            if self.closed:
                return
            if len(self.inbox) == self.inbox.maxlen:
                self.dropped += 1
            self.inbox.append(message)
            if not self.scheduled:
                self.scheduled = self.scope._post(self._deliver)

    def _deliver(self):
        with self.lock:
            values = list(self.inbox)
            self.inbox.clear()
            self.scheduled = False
        if self.closed:
            return
        for value in values:
            if len(self.buffer) == self.buffer.maxlen:
                self.dropped += 1
            self.buffer.append(value)
            self.latest = value
        self.event.set()

    def clear(self):
        with self.lock:
            self.inbox.clear()
        self.buffer.clear()
        self.latest = None

    async def next(self, *, timeout_s=None):
        async with asyncio.timeout(timeout_s):
            while not self.buffer:
                if self.closed:
                    raise RuntimeError("subscription closed")
                if self.scope.bridge.spin_error:
                    raise self.scope.bridge.spin_error
                self.event.clear()
                await self.event.wait()
            return self.buffer.popleft()

    def close(self):
        with self.lock:
            if self.closed:
                return
            self.closed = True
        self.clear()
        self.event.set()
        self.scope.bridge.node.destroy_subscription(self.handle)
        self.scope.subscriptions.remove(self)


class Goal:
    """An action goal, sent as it is made. Awaiting it gives the action's result once the goal has finished; a
    goal its device rejects, aborts or cancels raises. status is sending, executing, then succeeded, canceled,
    aborted or rejected; feedback is the latest the device sent, and result the action's result. A goal advances
    no world time: wait for it on the world."""

    def __init__(self, scope, reference, spec, goal):
        self.scope, self.reference, self.type = scope, reference, spec["type"]
        self.feedback = self.result = self.handle = None
        self.status = "sending"
        self.accepted = asyncio.ensure_future(self._send(spec, goal))
        self.task = asyncio.ensure_future(self._finish())
        for task in (self.accepted, self.task):  # a failure nobody awaits is the goal's status, not a warning
            task.add_done_callback(lambda done: done.cancelled() or done.exception())
        self.accepted.add_done_callback(lambda _: scope.world.kick.set())

    def _failure(self, text):
        from rosidl_runtime_py.convert import message_to_ordereddict
        reason = getattr(self.result, "error_string", "")
        return RPCError(f"{self.reference} {text}" + (f": {reason}" if reason else ""), code=f"goal_{self.status}", details={
            "operation": self.reference, "type": self.type,
            **({} if self.result is None else {"result": message_to_ordereddict(self.result)})})

    async def _send(self, spec, goal):
        scope, timeout_s = self.scope, spec.get("timeout_s", 10)
        with scope.world.hold():
            await scope._enroll(self.reference)
            async with asyncio.timeout(timeout_s):
                client = await scope._action(self.reference, spec)
                self.handle = await scope._future(client.send_goal_async(goal, feedback_callback=self._feedback), timeout_s)
        self.status = "executing" if self.handle.accepted else "rejected"
        if not self.handle.accepted:
            raise self._failure("rejected the goal")

    def _feedback(self, message):
        self.feedback = message.feedback

    async def _finish(self):
        await self.accepted
        reply = await self.scope._future(self.handle.get_result_async(), None)
        self.status, self.result = STATUS.get(reply.status, "aborted"), reply.result
        if self.status != "succeeded":
            raise self._failure(f"was {self.status}")
        return self.result

    def __await__(self):
        return asyncio.shield(self.task).__await__()

    async def cancel(self):
        """Ask the device to end the goal; awaiting it then raises as canceled."""
        with self.scope.world.hold():
            await asyncio.wait([self.accepted])
            if self.status == "executing" and (await self.scope._future(self.handle.cancel_goal_async(), 10)).goals_canceling:
                await asyncio.wait([self.task], timeout=10)  # its end, as the device reports it


class Bridge:
    """The ROS side: one context, node and executor thread, the world's clock, and the clients and publishers
    of the catalog's operations, which outlive the scopes that use them."""

    def __init__(self, catalog, domain_id=0):
        try:
            import rclpy
            import tf2_ros  # Validate the Kinex ROS client environment before acquiring resources.
        except ImportError as error:
            raise RPCError("Kinex Python lacks ROS support; prepare its ROS environment. Do not switch to a device or simulator interpreter.",
                           code="ros_environment_unavailable") from error
        from rclpy.context import Context
        from rclpy.executors import SingleThreadedExecutor
        self.catalog, self.scopes = catalog, set()  # the caller's mapping: it gains and loses devices as they load
        self.clients, self.actions, self.publishers, self.extra_nodes = {}, {}, {}, []
        self.spin_error = self.tf = self.world_stamp = None
        self.world_epoch = 0
        self.clock = next((op for op in catalog.values() if op["type"] == CLOCK and op["direction"] == "output"), None)
        self.context = Context()
        arguments = ["--ros-args", "-p", "use_sim_time:=true"] if self.clock else []
        # Context arguments apply to device factory nodes as well as this client.
        rclpy.init(args=arguments, context=self.context, domain_id=domain_id)
        self.node = rclpy.create_node("kinex_" + uuid.uuid4().hex, context=self.context)
        if self.clock:
            from rosgraph_msgs.msg import Clock
            self.node.create_subscription(Clock, self.clock["endpoint"], self._clock, qos(self.clock))
        # Async service callbacks yield to this executor. Computation devices
        # have separate processes, so idle transport clients need no worker pool.
        self.executor = SingleThreadedExecutor(context=self.context)
        self.executor.add_node(self.node)
        self.thread = threading.Thread(target=self._spin, daemon=True)
        self.thread.start()

    def unload(self, device):
        """Release the clients this bridge made for a device's operations."""
        for clients, destroy in ((self.publishers, self.node.destroy_publisher), (self.clients, self.node.destroy_client),
                                 (self.actions, lambda client: client.destroy())):
            for reference in [reference for reference in clients if reference.split(".")[0] == device]:
                destroy(clients.pop(reference))

    def _clock(self, message):
        stamp = message.clock.sec * 1_000_000_000 + message.clock.nanosec
        if self.world_stamp is not None and stamp < self.world_stamp:
            self.world_epoch += 1
        self.world_stamp = stamp
        if self.tf is not None:
            self.tf.observe_clock(stamp)
        for scope in tuple(self.scopes):
            scope._notify()

    def _spin(self):
        from rclpy.executors import ExternalShutdownException
        try:
            self.executor.spin()
        except ExternalShutdownException:
            pass
        except Exception as error:
            self.spin_error = error
            for scope in tuple(self.scopes):
                scope._post(scope._failed, error)

    def transforms(self, history_s=None):
        """The domain's tf2 history, listened to from its first use."""
        if self.tf is None:
            from kinex.host.frame_graph import SCOPE_HISTORY_S, listen
            self.tf, self.tf_listener = listen(self.node, history_s or SCOPE_HISTORY_S)
            if self.world_stamp is not None:
                self.tf.observe_clock(self.world_stamp)
        return self.tf

    async def close(self):
        if self.tf is not None:
            self.tf_listener.unregister()
        for client in self.actions.values():
            client.destroy()
        await asyncio.to_thread(self.executor.shutdown, timeout_sec=2)
        for node in self.extra_nodes:
            node.destroy_node()
        self.node.destroy_node()
        self.context.try_shutdown()
        await asyncio.to_thread(self.thread.join, 2)


class Scope:
    """One program's use of a bridge, bound to that program's event loop: its streams, goals and world waits,
    and the devices it commanded. It binds on its first use inside the loop; closing it releases what the program
    made, flushing its commands on success and stopping its devices on failure, and leaves a bridge it was given
    as it found it."""

    def __init__(self, bridge=None, *, catalog=None, domain_id=0, enroll=None):
        from kinex.world import World
        # Without a bridge the scope makes its own on first use, and closes it.
        self.given, self.owned, self.cold = bridge, None, (catalog or {}, domain_id)
        self.enroll = enroll  # reports a device to the host before its first command
        self.subscriptions, self.topics, self.unacknowledged = [], {}, set()
        self.enrolled, self.pending = set(), set()
        self.enroll_lock = asyncio.Lock()
        self.clock_scheduled = self.opened = self.closed = False
        self.world = World(self)

    @property
    def bridge(self):
        if self.given is None:
            self.given = self.owned = Bridge(*self.cold)
        return self.given

    @property
    def catalog(self):
        """The operations by reference; naming one starts no ROS."""
        return self.cold[0] if self.given is None else self.given.catalog

    def open(self):
        """Bind to the running event loop, once: what a program awaits belongs to its one loop."""
        if self.opened:
            if self.loop.is_closed():
                raise RuntimeError("devices belong to the program's event loop, which has ended: use one asyncio.run(main())")
            return self
        self.loop = asyncio.get_running_loop()
        self.epoch = self.bridge.world_epoch
        self.bridge.scopes.add(self)
        self.opened = True
        return self

    async def __aenter__(self):
        self.open()
        self.token = _active.set(self)
        return self

    def _post(self, callback, *args):
        """Hand a callback from a ROS thread to the event loop; False once that loop has closed."""
        try:
            self.loop.call_soon_threadsafe(callback, *args)
        except RuntimeError:
            return False
        return True

    def _notify(self):
        """The world's clock moved; one delivery carries every move since the last."""
        if not self.clock_scheduled:
            self.clock_scheduled = True  # before posting: the loop may deliver at once
            if not self._post(self._clock):
                self.clock_scheduled = False

    def _clock(self):
        self.clock_scheduled = False
        if self.closed:
            return
        if self.epoch != self.bridge.world_epoch:
            # A clock that starts again, as a new simulator run's does, invalidates what was observed before it.
            self.epoch = self.bridge.world_epoch
            for stream in self.subscriptions:
                stream.clear()

    def _failed(self, error):
        if self.closed:
            return
        for stream in self.subscriptions:
            stream.event.set()
        for future in tuple(self.pending):
            if not future.done():
                future.set_exception(error)

    def operation(self, reference, transport=None, direction=None):
        if self.closed:
            raise RuntimeError("communication scope closed")
        if self.given is not None and self.given.spin_error:
            raise self.given.spin_error
        spec = self.catalog.get(reference)
        if spec is None and self.enroll and all(name.startswith("_") for name in self.catalog):
            raise RPCError("No device operations are ready. Query runtime.devices(); load required devices through the host first.",
                           code="devices_not_ready")
        if spec is None:
            raise RPCError(f"unknown or unavailable operation {reference}; query runtime.operations(device) and runtime.devices()", code="operation_unavailable", details={"operation": reference})
        if transport and spec["transport"] != transport:
            raise TypeError(f"{reference} is a {spec['transport']}, not a {transport}")
        if direction and spec["direction"] != direction:
            raise TypeError(f"{reference} is not a device {direction}")
        return spec

    def device(self, name):
        from kinex.device import Device
        return Device(self, name)

    def subscribe(self, spec, depth=None):
        self.open()
        stream = Subscription(self, spec, depth)
        self.subscriptions.append(stream)
        return stream

    async def _enroll(self, reference):
        """Report a commanded device so the host stops it if this program fails."""
        device = reference.split(".", 1)[0]
        async with self.enroll_lock:
            if device in self.enrolled:
                return
            if self.enroll:
                await self.enroll(device)
            self.enrolled.add(device)

    async def _future(self, ros_future, timeout_s):
        future = self.open().loop.create_future()
        self.pending.add(future)
        def complete(done):
            def deliver():
                if future.done():
                    return
                try:
                    future.set_result(done.result())
                except Exception as error:
                    future.set_exception(error)
            self._post(deliver)
        ros_future.add_done_callback(complete)
        try:
            async with asyncio.timeout(timeout_s):
                return await future
        finally:
            self.pending.discard(future)
            if not ros_future.done():
                ros_future.cancel()

    def _client(self, reference, spec):
        from rosidl_runtime_py.utilities import get_service
        clients = self.bridge.clients
        if reference not in clients:
            clients[reference] = self.bridge.node.create_client(get_service(spec["type"]), spec["endpoint"])
        return clients[reference]

    async def _discovered(self, client):
        while not client.service_is_ready():
            if self.closed:
                raise asyncio.CancelledError()
            await asyncio.sleep(.01)  # Transport discovery, never world scheduling.

    async def _request(self, reference, spec, fields, timeout_s=None):
        client = self._client(reference, spec)
        timeout_s = spec.get("timeout_s", 10) if timeout_s is None else timeout_s
        async with asyncio.timeout(timeout_s):
            await self._discovered(client)
            result = await self._future(client.call_async(message_value(client.srv_type.Request, fields)), timeout_s)
        if hasattr(result, "success") and not result.success:
            raise OperationError(reference, spec["type"], result)
        return result

    async def _action(self, reference, spec):
        """The action's client, once its server is discovered."""
        from rclpy.action import ActionClient
        from rosidl_runtime_py.utilities import get_action
        actions = self.bridge.actions
        if reference not in actions:
            actions[reference] = ActionClient(self.bridge.node, get_action(spec["type"]), spec["endpoint"])
        while not actions[reference].server_is_ready():
            await asyncio.sleep(.01)  # Transport discovery, never world scheduling.
        return actions[reference]

    def act(self, reference, goal=None, **fields):
        """Send an action its goal, a message or field mapping, or its fields by name: the Goal, already sent."""
        from rosidl_runtime_py.utilities import get_action
        spec = self.operation(reference, "action", "input")
        return Goal(self, reference, spec, message_value(get_action(spec["type"]).Goal, fields if goal is None else goal))

    async def request(self, reference, *, timeout_s=None, **fields):
        """Call a service with its request's fields; the response, or for a Json operation its decoded object."""
        spec = self.operation(reference, "service", "input")
        with self.world.hold():
            await self._enroll(reference)
            if spec["type"] != JSON:
                return await self._request(reference, spec, fields, timeout_s)
            result = await self._request(reference, spec, {"request": json.dumps(fields, allow_nan=False)}, timeout_s)
            return json.loads(result.response)

    async def publish(self, reference, message):
        from rosidl_runtime_py.utilities import get_message
        spec = self.operation(reference, "topic", "input")
        value = message_value(get_message(spec["type"]), message)
        with self.world.hold():
            await self._enroll(reference)
            publisher = self.bridge.publishers.get(reference)
            if publisher is None:
                publisher = self.bridge.publishers[reference] = self.bridge.node.create_publisher(type(value), spec["endpoint"], qos(spec))
            stop = reference.split(".", 1)[0] + ".stop"
            async with asyncio.timeout(spec.get("timeout_s", 10)):
                # Nodes serve stop after their command subscriptions: once it is discovered,
                # the command reaches the device itself, not only another subscriber.
                if stop in self.catalog:
                    await self._discovered(self._client(stop, self.catalog[stop]))
                while publisher.get_subscription_count() == 0:
                    await asyncio.sleep(.01)
            publisher.publish(value)
            self.unacknowledged.add(reference)

    async def _flush(self):
        """Wait until reliable subscribers acknowledge the commands sent since the last flush: a stepped world
        advances only past commands its devices hold, and teardown would drop one still on its way."""
        if not self.unacknowledged:
            return
        from rclpy.duration import Duration
        sent, self.unacknowledged = sorted(self.unacknowledged), set()
        lost = [reference for reference in sent
                if not await asyncio.to_thread(self.bridge.publishers[reference].wait_for_all_acked, Duration(seconds=2))]
        if lost:
            raise TimeoutError(f"commands were not acknowledged: {', '.join(lost)}")

    async def _stop(self, devices):
        """Call each device's declared stop service once; devices without one are skipped."""
        failures = []
        for device in devices:
            spec = self.catalog.get(f"{device}.stop")
            if spec is None:
                continue
            try:
                await self._request(f"{device}.stop", spec, {}, 2)
            except Exception as error:
                failures.append(error)
        if failures:
            raise ExceptionGroup("device stop failed", failures)

    async def close(self, error=None):
        """Release the scope: success flushes commands, failure stops every commanded device."""
        if self.closed or self.given is None:
            return
        # exec closes its scope after the program's own loop has ended.
        self.loop = asyncio.get_running_loop()
        succeeded = error is None or isinstance(error, SystemExit) and error.code in (None, 0)
        failure = self.bridge.spin_error if succeeded else error
        try:
            await self.world.close()
            if failure is None:
                try:
                    await self._flush()
                except Exception as unsent:
                    failure = unsent
            # Failure stops every device this scope commanded; success leaves motion running.
            if failure is not None:
                try:
                    await self._stop(sorted(self.enrolled))
                except Exception as cleanup:
                    failure.add_note(f"device stop failed: {cleanup}")
                if succeeded:
                    raise failure
        finally:
            self.closed = True
            self.bridge.scopes.discard(self)
            for future in tuple(self.pending):
                future.cancel()
            for stream in tuple(self.subscriptions):
                stream.close()
            if self.owned:
                await self.bridge.close()

    async def __aexit__(self, kind, error, traceback):
        try:
            await self.close(error)
        finally:
            _active.reset(self.token)


def communication(catalog=None, *, domain_id=0):
    """A scope with a bridge of its own, for a standalone client to enter; exec gives a program its scope."""
    return Scope(catalog=catalog, domain_id=domain_id)


@contextlib.contextmanager
def ambient(scope):
    """Make a scope the active one for a block, as exec does for a program."""
    token = _active.set(scope)
    try:
        yield scope
    finally:
        _active.reset(token)


def scope():
    """The active scope."""
    active = _active.get()
    if active is None:
        raise RuntimeError("no communication scope: run through exec or enter communication()")
    return active

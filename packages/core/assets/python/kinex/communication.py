"""Invocation-scoped asyncio pub/sub and request/response over ROS 2.

Imports are inert. exec owns one scope per invocation, reached as `kinex.io` and opened
on first use; a standalone client enters communication() itself. World operations are
the sole source of workflow timing.
"""
import asyncio
from collections import deque
import contextlib
import contextvars
import importlib
import json
from numbers import Real
import threading
import time
import uuid
from kinex.common.geometry import vector
from kinex.common.plain import TIMES, ros_type
from kinex.errors import RPCError, OperationError

_active = contextvars.ContextVar("kinex_communication", default=None)
# Free-form operations carry JSON objects; their descriptions define the fields.
JSON = "custom_interfaces/srv/Json"
WAIT = "custom_interfaces/srv/Wait"
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


def queue(spec, depth=None):
    """How many messages a subscription keeps: depth, or the operation's own."""
    size = depth if depth is not None else spec.get("qos", {}).get("depth", 1)
    if not isinstance(size, int) or isinstance(size, bool) or not 1 <= size <= 1024:
        raise ValueError("subscription depth must be in [1, 1024]")
    return size


def qos(spec, depth=None):
    from rclpy.qos import QoSProfile, ReliabilityPolicy, DurabilityPolicy
    fields = spec.get("qos", {})
    return QoSProfile(
        depth=queue(spec, depth),
        reliability=(ReliabilityPolicy.BEST_EFFORT if fields.get("reliability") == "best_effort"
                     else ReliabilityPolicy.RELIABLE),
        durability=(DurabilityPolicy.TRANSIENT_LOCAL if fields.get("durability") == "transient_local"
                    else DurabilityPolicy.VOLATILE))


class Subscription:
    def __init__(self, io, spec, depth):
        self.io, self.spec = io, spec
        self.buffer = deque(maxlen=queue(spec, depth))
        self.event = asyncio.Event()
        self.last = None
        self.closed = False
        self.dropped = 0
        # A single scheduled delivery and bounded cross-thread inbox prevent
        # slow event-loop consumers from creating an unbounded callback queue.
        self.inbox = deque(maxlen=self.buffer.maxlen)
        self.lock = threading.Lock()
        self.scheduled = False
        self.handle = io._listen(self, depth)

    def _receive(self, message):
        with self.lock:
            if self.closed:
                return
            if len(self.inbox) == self.inbox.maxlen:
                self.dropped += 1
            self.inbox.append((message, time.monotonic()))
            if not self.scheduled:
                self.scheduled = self.io._post(self._deliver)

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
            self.last = value
        self.event.set()

    async def next(self, *, timeout_s=None):
        async with asyncio.timeout(timeout_s):
            while not self.buffer:
                if self.closed:
                    raise RuntimeError("subscription closed")
                if self.io.spin_error:
                    raise self.io.spin_error
                self.event.clear()
                await self.event.wait()
            return self.buffer.popleft()[0]

    def latest(self, *, max_age_s=None):
        # This is a receipt-age bound for transport freshness, not world time.
        if self.last is None:
            return None
        message, received = self.last
        if max_age_s is not None and time.monotonic() - received > max_age_s:
            raise TimeoutError("cached observation is stale")
        return message

    # A context manager closes the stream on exit; the scope closes any others at its end.
    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        self.close()

    def close(self):
        with self.lock:
            if self.closed:
                return
            self.closed = True
            self.inbox.clear()
        self.buffer.clear()
        self.last = None
        self.event.set()
        self.io._unlisten(self.handle)
        if self in self.io.subscriptions:
            self.io.subscriptions.remove(self)


class Goal:
    """An action goal its device is executing. status is executing, then succeeded, canceled or aborted;
    feedback is the latest the device sent, and result the action's result once the goal has finished. A world
    wait takes goals to wait for: sending one advances no world time."""

    def __init__(self, io):
        self.io, self.feedback, self.result, self.status = io, None, None, "executing"

    def _feedback(self, message):
        self.feedback = message.feedback

    def _finished(self, reply):
        if not reply.cancelled() and reply.exception() is None:
            self.status, self.result = STATUS[reply.result().status], reply.result().result

    @property
    def done(self):
        return self.result is not None

    async def wait(self):
        """The result once the goal has finished. Only a world wait advances a stepped world to it."""
        await asyncio.shield(self.reply)
        return self.result

    async def cancel(self):
        await self.io._future(self.handle.cancel_goal_async(), 10)


class Communication:
    goal = Goal  # what act returns

    def __init__(self, catalog=None, *, domain_id=None):
        from kinex import _request
        startup = (_request or {}).get("ros", {})
        self.frame_service = startup.get("frames") if catalog is None else None
        self.catalog = catalog if catalog is not None else startup.get("catalog", {})
        self.namespace = "/kinex/invocations/i_" + uuid.uuid4().hex
        self.domain_id = domain_id if domain_id is not None else startup.get("domain_id", 0)
        self.supervised = catalog is None and bool(startup)
        self.subscriptions = []
        self.publishers = {}
        self.clients = {}
        self.actions = {}
        self.enrolled = set()
        self.enroll_lock = asyncio.Lock()
        self.pending = set()
        self.handlers = set()
        self.spin_error = None
        self.extra_nodes = []
        self.opened = False
        self.closed = False
        self.tf = None

    def open(self):
        """Acquire ROS resources once, inside the running event loop."""
        if self.opened:
            if self.loop.is_closed():
                raise RuntimeError("io belongs to the program's event loop, which has ended: use one asyncio.run(main())")
            return self
        if self.supervised and not self.catalog:
            raise RPCError("No device operations are ready. Query runtime.devices(); load required devices through the host before using io.",
                           code="devices_not_ready")
        self.loop = asyncio.get_running_loop()
        self._acquire()
        self.opened = True
        return self

    def _acquire(self):
        """The scope's own ROS client: a node, spun on a thread of its own."""
        try:
            import rclpy
            import tf2_ros  # Validate the Kinex ROS client environment before acquiring resources.
        except ImportError as error:
            raise RPCError("Kinex Python lacks ROS support; prepare its ROS environment. Do not switch to a device or simulator interpreter.",
                           code="ros_environment_unavailable") from error
        from rclpy.context import Context
        from rclpy.executors import SingleThreadedExecutor
        self.context = Context()
        clocks = [op for op in self.catalog.values() if op["type"] == "rosgraph_msgs/msg/Clock" and op["direction"] == "output"]
        arguments = []
        if clocks:
            arguments = ["--ros-args", "-p", "use_sim_time:=true", "-r", f"/clock:={clocks[0]['endpoint']}"]
        # Context arguments apply to device factory nodes as well as this client.
        rclpy.init(args=arguments, context=self.context, domain_id=self.domain_id)
        self.node = rclpy.create_node("kinex_" + uuid.uuid4().hex, context=self.context)
        self.world_stamp = None
        self.world_epoch = 0
        self.clock_lock = threading.Lock()
        self.clock_pending = None
        self.clock_scheduled = False
        if clocks:
            from rosgraph_msgs.msg import Clock
            self.clock_subscription = self.node.create_subscription(
                Clock, clocks[0]["endpoint"],
                self._clock_received, qos(clocks[0]))
        # Async service callbacks yield to this executor. Computation devices
        # have separate processes, so idle transport clients need no worker pool.
        self.executor = SingleThreadedExecutor(context=self.context)
        self.executor.add_node(self.node)
        self.thread = threading.Thread(target=self._spin, daemon=True)
        self.thread.start()

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

    def _clock_received(self, message):
        with self.clock_lock:
            self.clock_pending = message
            if not self.clock_scheduled:
                self.clock_scheduled = self._post(self._clock_deliver)

    def _clock_deliver(self):
        with self.clock_lock:
            message = self.clock_pending
            self.clock_scheduled = False
        if not self.closed:
            self._clock(message)

    def _clock(self, message):
        stamp = message.clock.sec * 1_000_000_000 + message.clock.nanosec
        if self.world_stamp is not None and stamp < self.world_stamp:
            self.world_epoch += 1
            for stream in self.subscriptions:
                with stream.lock:
                    stream.inbox.clear()
                stream.buffer.clear()
                stream.last = None
        if self.tf is not None:
            self.tf.observe_clock(stamp)
        self.world_stamp = stamp

    def _spin(self):
        from rclpy.executors import ExternalShutdownException
        try:
            self.executor.spin()
        except ExternalShutdownException:
            pass
        except Exception as error:
            self._post(self._failed, error)

    def _failed(self, error):
        if self.closed:
            return
        self.spin_error = error
        for stream in self.subscriptions:
            stream.event.set()
        for future in tuple(self.pending):
            if not future.done():
                future.set_exception(error)

    def operation(self, reference, transport=None, direction=None):
        if self.closed:
            raise RuntimeError("communication scope closed")
        if self.spin_error:
            raise self.spin_error
        spec = self.catalog.get(reference)
        if spec is None:
            raise RPCError(f"unknown or unavailable operation {reference}; query runtime.operations(device) and runtime.devices()", code="operation_unavailable", details={"operation": reference})
        if transport and spec["transport"] != transport:
            raise TypeError(f"{reference} is not a {transport}")
        if direction and spec["direction"] != direction:
            raise TypeError(f"{reference} is not a device {direction}")
        return spec

    def _listen(self, stream, depth):
        """Receive a stream's topic: its handle, which _unlisten releases."""
        from rosidl_runtime_py.utilities import get_message
        return self.node.create_subscription(get_message(stream.spec["type"]), stream.spec["endpoint"],
                                             stream._receive, qos(stream.spec, depth))

    def _unlisten(self, handle):
        self.node.destroy_subscription(handle)

    def subscribe(self, operation, *, depth=None):
        stream = Subscription(self, self.operation(operation, "topic", "output"), depth)
        self.subscriptions.append(stream)
        return stream

    async def read(self, operation, *, timeout_s=None):
        """The next message on an output topic; timeout_s defaults to the operation's."""
        with self.subscribe(operation) as stream:
            return await stream.next(timeout_s=stream.spec.get("timeout_s", 10) if timeout_s is None else timeout_s)

    async def _enroll(self, operation):
        """Report a commanded device so the host stops it if this invocation fails."""
        device = operation.split(".", 1)[0]
        async with self.enroll_lock:
            if device in self.enrolled:
                return
            if self.supervised:
                from kinex import _rpc
                await asyncio.to_thread(_rpc, {"call": "ros_enroll", "device": device})
            self.enrolled.add(device)

    async def _future(self, ros_future, timeout_s):
        future = self.loop.create_future()
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

    def _client(self, spec):
        from rosidl_runtime_py.utilities import get_service
        key = (spec["endpoint"], spec["type"])
        if key not in self.clients:
            self.clients[key] = self.node.create_client(get_service(spec["type"]), spec["endpoint"])
        return self.clients[key]

    async def _discovered(self, client):
        while not client.service_is_ready():
            if self.closed:
                raise asyncio.CancelledError()
            await asyncio.sleep(.01)  # Transport discovery, never world scheduling.

    async def _request(self, spec, fields, timeout_s=None, *, operation=None):
        client = self._client(spec)
        timeout_s = spec.get("timeout_s", 10) if timeout_s is None else timeout_s
        async with asyncio.timeout(timeout_s):
            await self._discovered(client)
            result = await self._future(client.call_async(message_value(client.srv_type.Request, fields)), timeout_s)
        if hasattr(result, "success") and not result.success:
            raise OperationError(operation or spec["endpoint"], spec["type"], result)
        return result

    async def _action(self, spec):
        """The action's client, once its server is discovered."""
        from rclpy.action import ActionClient
        from rosidl_runtime_py.utilities import get_action
        key = (spec["endpoint"], spec["type"])
        if key not in self.actions:
            self.actions[key] = ActionClient(self.node, get_action(spec["type"]), spec["endpoint"])
        while not self.actions[key].server_is_ready():
            await asyncio.sleep(.01)  # Transport discovery, never world scheduling.
        return self.actions[key]

    async def act(self, operation, goal):
        """Send an action its goal, a message or field mapping; the Goal once the device accepts it. A
        rejected goal raises. The goal then runs as world time passes: this never waits for it."""
        spec = self.operation(operation, "action", "input")
        await self._enroll(operation)
        sent, timeout_s = self.goal(self), spec.get("timeout_s", 10)
        async with asyncio.timeout(timeout_s):
            client = await self._action(spec)
            sent.handle = await self._future(client.send_goal_async(
                message_value(client._action_type.Goal, goal), feedback_callback=sent._feedback), timeout_s)
            if not sent.handle.accepted:
                raise RPCError(f"{operation} rejected the goal", code="operation_rejected",
                               details={"operation": operation, "type": spec["type"]})
            sent.reply = asyncio.ensure_future(self._future(sent.handle.get_result_async(), None))
            sent.reply.add_done_callback(sent._finished)
        return sent

    async def request(self, operation, *, timeout_s=None, **fields):
        spec = self.operation(operation, "service", "input")
        await self._enroll(operation)
        try:
            if spec["type"] == WAIT and fields.get("goals"):
                goals, patience = fields["goals"], fields.get("goal_timeout_s")
                fields = {**fields, "goals": [{"uuid": goal.handle.goal_id.uuid} for goal in goals]}
                result = await self._request(spec, fields, timeout_s, operation=operation)
                if len(result.finished) < len(goals):
                    # A world that does not observe goals, where time passes by itself, has only waited
                    # duration_s: await the goals here, cancelling those still executing at their timeout.
                    started, waits = self.loop.time(), [asyncio.ensure_future(goal.wait()) for goal in goals]
                    await asyncio.wait(waits, timeout=max(0., patience - result.waited_s) if patience else None)
                    for goal in goals:
                        if not goal.done:
                            await goal.cancel()
                    result.finished = [True] * len(goals)
                    result.waited_s += self.loop.time() - started
                    result.time_s += self.loop.time() - started
                # The results of the goals the wait saw finish have arrived when it returns.
                await asyncio.gather(*(goal.wait() for goal, finished in zip(goals, result.finished) if finished))
                return result
            if spec["type"] != JSON:
                return await self._request(spec, fields, timeout_s, operation=operation)
            result = await self._request(spec, {"request": json.dumps(fields, allow_nan=False)}, timeout_s, operation=operation)
            return json.loads(result.response)
        except BaseException as error:
            # An abandoned wait would keep advancing a stepped world.
            if spec["type"] == WAIT and not isinstance(error, OperationError):
                try:
                    await self._stop([operation.split(".", 1)[0]])
                except Exception as cleanup:
                    error.add_note(f"wait cleanup failed: {cleanup}")
            raise

    async def publish(self, operation, message):
        from rosidl_runtime_py.utilities import get_message
        spec = self.operation(operation, "topic", "input")
        value = message_value(get_message(spec["type"]), message)
        await self._enroll(operation)
        publisher = self.publishers.get(operation)
        if publisher is None:
            publisher = self.node.create_publisher(type(value), spec["endpoint"], qos(spec))
            self.publishers[operation] = publisher
        stop = self.catalog.get(operation.split(".", 1)[0] + ".stop")
        async with asyncio.timeout(spec.get("timeout_s", 10)):
            # Nodes serve stop after their command subscriptions: once it is discovered,
            # the command reaches the device itself, not only another subscriber.
            if stop:
                await self._discovered(self._client(stop))
            while publisher.get_subscription_count() == 0:
                await asyncio.sleep(.01)
        publisher.publish(value)

    async def _flush(self):
        """Wait until reliable subscribers acknowledge every command; teardown would drop it."""
        if not self.publishers:
            return
        from rclpy.duration import Duration
        unacknowledged = [operation for operation, publisher in self.publishers.items()
                          if not await asyncio.to_thread(publisher.wait_for_all_acked, Duration(seconds=2))]
        if unacknowledged:
            raise TimeoutError(f"commands were not acknowledged: {', '.join(unacknowledged)}")

    async def _stop(self, devices):
        """Call each device's declared stop service once; devices without one are skipped."""
        failures = []
        for device in devices:
            spec = self.catalog.get(f"{device}.stop")
            if spec is None:
                continue
            try:
                await self._request(spec, {}, 2, operation=f"{device}.stop")
            except Exception as error:
                failures.append(error)
        if failures:
            raise ExceptionGroup("device stop failed", failures)

    def serve(self, interface, handler):
        from rosidl_runtime_py.utilities import get_service
        from rclpy.callback_groups import ReentrantCallbackGroup
        cls = get_service(interface["type"])
        endpoint = interface["endpoint"]
        if not endpoint.startswith(self.namespace + "/"):
            raise ValueError("temporary services must use this invocation's namespace")
        async def invoke(request, response):
            async def run():
                result = handler(request)
                return await result if hasattr(result, "__await__") else result
            # ROS futures yield executor workers; asyncio executes the handler.
            from rclpy.task import Future
            bridge = Future(executor=self.executor)
            if self.loop.is_closed():  # the program has ended; its request stays unanswered
                return await bridge
            pending = asyncio.run_coroutine_threadsafe(run(), self.loop)
            self.handlers.add(pending)
            def complete(done):
                self.handlers.discard(done)
                try:
                    bridge.set_result(message_value(cls.Response, done.result()))
                except Exception as error:
                    bridge.set_exception(error)
            pending.add_done_callback(complete)
            return await bridge
        self.node.create_service(cls, endpoint, invoke, callback_group=ReentrantCallbackGroup())
        return endpoint

    def transforms(self):
        if self.tf is None:
            from kinex.host.frame_graph import listen
            self.tf, self.tf_listener = listen(self.node)
            if self.world_stamp is not None:
                self.tf.observe_clock(self.world_stamp)
        return self.tf

    async def close(self, error=None):
        """Release the scope: success flushes commands, failure stops every commanded device."""
        if not self.opened or self.closed:
            return
        # exec closes its scope after the program's own loop has ended.
        self.loop = asyncio.get_running_loop()
        succeeded = error is None or isinstance(error, SystemExit) and error.code in (None, 0)
        failure = self.spin_error if succeeded else error
        try:
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
            for future in tuple(self.pending):
                future.cancel()
            handlers = tuple(self.handlers)
            for handler in handlers:
                handler.cancel()
            await asyncio.gather(*(asyncio.wrap_future(handler) for handler in handlers), return_exceptions=True)
            for stream in tuple(self.subscriptions):
                stream.close()
            await self._release()

    async def _release(self):
        """Give up what _acquire made."""
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

    async def __aexit__(self, kind, error, traceback):
        try:
            await self.close(error)
        finally:
            _active.reset(self.token)


def communication(catalog=None, *, domain_id=None):
    """A scope for a standalone client to enter; inside exec, use `kinex.io`."""
    return Communication(catalog, domain_id=domain_id)


@contextlib.contextmanager
def ambient(scope):
    """Make a scope the active one for a block, as exec does for an invocation."""
    token = _active.set(scope)
    try:
        yield scope
    finally:
        _active.reset(token)


def scope():
    """The active communication scope, opened on first use."""
    active = _active.get()
    if active is None:
        raise RuntimeError("no communication scope: run through exec or enter communication()")
    if isinstance(active, Communication):
        active.open()
    return active


class _Ambient:
    """`kinex.io`: the active scope's subscribe, read, publish, request and serve."""

    def __getattr__(self, name):
        return getattr(scope(), name)


io = _Ambient()

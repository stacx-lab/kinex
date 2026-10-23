"""Invocation-scoped asyncio pub/sub and request/response over ROS 2.

Imports are inert. ROS is initialized only when entering communication().
World operations are the sole source of workflow timing.
"""
import asyncio
from collections import deque
import contextvars
import json
import threading
import time
import uuid
from kinex.errors import RPCError, OperationError

_active = contextvars.ContextVar("kinex_communication", default=None)
# Free-form operations carry JSON objects; their descriptions define the fields.
JSON = "kinex_interfaces/srv/Json"
JSON_COMMAND = "kinex_interfaces/msg/JsonCommand"


def duration(seconds):
    """A builtin_interfaces Duration or Time payload from seconds."""
    nanoseconds = round(seconds * 1e9)
    return {"sec": nanoseconds // 1_000_000_000, "nanosec": nanoseconds % 1_000_000_000}


def message_value(cls, value):
    from rosidl_runtime_py.set_message import set_message_fields
    if isinstance(value, cls):
        return value
    if not isinstance(value, dict):
        raise TypeError(f"expected {cls.__name__} or field mapping")
    message = cls()
    set_message_fields(message, value)
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
    def __init__(self, io, spec, depth):
        from rosidl_runtime_py.utilities import get_message
        self.io, self.spec = io, spec
        self.buffer = deque(maxlen=qos(spec, depth).depth)
        self.event = asyncio.Event()
        self.last = None
        self.closed = False
        self.dropped = 0
        # A single scheduled delivery and bounded cross-thread inbox prevent
        # slow event-loop consumers from creating an unbounded callback queue.
        self.inbox = deque(maxlen=self.buffer.maxlen)
        self.lock = threading.Lock()
        self.scheduled = False
        self.handle = io.node.create_subscription(
            get_message(spec["type"]), spec["endpoint"], self._receive, qos(spec, depth))

    def _receive(self, message):
        with self.lock:
            if self.closed:
                return
            if len(self.inbox) == self.inbox.maxlen:
                self.dropped += 1
            self.inbox.append((message, time.monotonic()))
            if not self.scheduled:
                self.scheduled = True
                self.io.loop.call_soon_threadsafe(self._deliver)

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
                if self.io.motion_error:
                    raise self.io.motion_error
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

    def close(self):
        with self.lock:
            if self.closed:
                return
            self.closed = True
            self.inbox.clear()
        self.buffer.clear()
        self.last = None
        self.event.set()
        self.io.node.destroy_subscription(self.handle)
        if self in self.io.subscriptions:
            self.io.subscriptions.remove(self)


class Communication:
    def __init__(self, catalog=None, *, owner=None, domain_id=None):
        from kinex import _request
        startup = (_request or {}).get("ros", {})
        self.frame_service = startup.get("frames") if catalog is None else None
        self.catalog = catalog if catalog is not None else startup.get("catalog", {})
        self.owner = owner or startup.get("owner") or uuid.uuid4().hex
        self.namespace = "/kinex/invocations/i_" + self.owner.encode().hex()
        self.domain_id = domain_id if domain_id is not None else startup.get("domain_id", 0)
        self.supervised = catalog is None and bool(startup)
        self.subscriptions = []
        self.publishers = {}
        self.clients = {}
        self.services = []
        self.generations = {}
        self.motion_locks = {}
        self.enrolled = set()
        self.enroll_lock = asyncio.Lock()
        self.pending = set()
        self.waits = {}
        self.handlers = set()
        self.motion_pending = {}
        self.motion_error = None
        self.extra_nodes = []
        self.closed = False
        self.tf = None

    async def __aenter__(self):
        if self.supervised and not self.catalog:
            raise RPCError("No device operations are ready. Query runtime.devices(); load required devices through the host before communication().",
                           code="devices_not_ready")
        try:
            import rclpy
            import tf2_ros  # Validate the Kinex ROS client environment before acquiring resources.
        except ImportError as error:
            raise RPCError("Kinex Python lacks ROS support; prepare its ros-jazzy environment. Do not switch to a device or simulator interpreter.",
                           code="ros_environment_unavailable") from error
        from rclpy.context import Context
        from rclpy.executors import SingleThreadedExecutor
        self.loop = asyncio.get_running_loop()
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
        self.token = _active.set(self)
        return self

    def _clock_received(self, message):
        with self.clock_lock:
            self.clock_pending = message
            if not self.clock_scheduled:
                self.clock_scheduled = True
                self.loop.call_soon_threadsafe(self._clock_deliver)

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
            self.loop.call_soon_threadsafe(self._failed, error)

    def _failed(self, error):
        if self.closed:
            return
        self.motion_error = error
        for stream in self.subscriptions:
            stream.event.set()
        for future in tuple(self.pending):
            if not future.done():
                future.set_exception(error)

    def operation(self, reference, transport=None, direction=None):
        if self.closed:
            raise RuntimeError("communication scope closed")
        if self.motion_error:
            raise self.motion_error
        spec = self.catalog.get(reference)
        if spec is None:
            raise RPCError(f"unknown or unavailable operation {reference}; query runtime.operations(device) and runtime.devices()", code="operation_unavailable", details={"operation": reference})
        if transport and spec["transport"] != transport:
            raise TypeError(f"{reference} is not a {transport}")
        if direction and spec["direction"] != direction:
            raise TypeError(f"{reference} is not a device {direction}")
        return spec

    def subscribe(self, operation, *, depth=None):
        stream = Subscription(self, self.operation(operation, "topic", "output"), depth)
        self.subscriptions.append(stream)
        return stream

    async def _enroll(self, operation):
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
            self.loop.call_soon_threadsafe(deliver)
        ros_future.add_done_callback(complete)
        try:
            async with asyncio.timeout(timeout_s):
                return await future
        finally:
            self.pending.discard(future)
            if not ros_future.done():
                ros_future.cancel()

    async def _request(self, spec, fields, timeout_s=None, *, operation=None):
        from rosidl_runtime_py.utilities import get_service
        cls = get_service(spec["type"])
        key = (spec["endpoint"], spec["type"])
        client = self.clients.get(key)
        if client is None:
            client = self.node.create_client(cls, spec["endpoint"])
            self.clients[key] = client
        timeout_s = spec.get("timeout_s", 10) if timeout_s is None else timeout_s
        async with asyncio.timeout(timeout_s):
            while not client.service_is_ready():
                if self.closed:
                    raise asyncio.CancelledError()
                await asyncio.sleep(.01)  # Transport discovery, never world scheduling.
            result = await self._future(client.call_async(message_value(cls.Request, fields)), timeout_s)
        if hasattr(result, "success") and not result.success:
            raise OperationError(operation or spec["endpoint"], spec["type"], result)
        return result

    async def request(self, operation, *, timeout_s=None, **fields):
        spec = self.operation(operation, "service", "input")
        cancellation = spec.get("cancellation")
        if cancellation:
            await self._enroll(operation)
            fields = {**fields, "owner": self.owner, "request_id": uuid.uuid4().hex}
            self.waits[fields["request_id"]] = cancellation
        try:
            if spec["type"] != JSON:
                return await self._request(spec, fields, timeout_s, operation=operation)
            result = await self._request(spec, {"request": json.dumps(fields, allow_nan=False)}, timeout_s, operation=operation)
            return json.loads(result.response)
        except BaseException as error:
            if cancellation and not isinstance(error, OperationError):
                try:
                    await self._request(cancellation, {"owner": self.owner, "request_id": fields["request_id"]}, 2)
                except Exception as cleanup:
                    error.add_note(f"wait cleanup failed: {cleanup}")
            raise
        finally:
            if cancellation:
                self.waits.pop(fields["request_id"], None)

    async def publish(self, operation, message):
        from rosidl_runtime_py.utilities import get_message
        spec = self.operation(operation, "topic", "input")
        if spec["type"] == JSON_COMMAND:
            message = {"data": json.dumps(message, allow_nan=False)}
        value = message_value(get_message(spec["type"]), message)
        motion = spec.get("motion")
        if motion:
            await self._enroll(operation)
            async with self.motion_locks.setdefault(operation, asyncio.Lock()):
                if operation not in self.generations:
                    result = await self._request(
                        {"endpoint": motion["acquire"], "type": "kinex_interfaces/srv/Acquire"},
                        {"owner": self.owner})
                    self.generations[operation] = result.generation
                    status = {"endpoint": motion["status"], "type": "kinex_interfaces/msg/CommandStatus",
                              "qos": {"depth": 64, "durability": "transient_local"}}
                    stream = Subscription(self, status, 64)
                    self.subscriptions.append(stream)
                    task = asyncio.create_task(self._acceptances(stream))
                    self.motion_pending[operation] = (task, {})
            value.owner, value.generation, value.command_id = (
                self.owner, self.generations[operation], uuid.uuid4().hex)
            pending = self.motion_pending[operation][1]
            if len(pending) >= 32:
                await self.accepted(operation, next(iter(pending)))
            pending[value.command_id] = self.loop.create_future()
        publisher = self.publishers.get(operation)
        if publisher is None:
            publisher = self.node.create_publisher(type(value), spec["endpoint"], qos(spec))
            self.publishers[operation] = publisher
        async with asyncio.timeout(spec.get("timeout_s", 10)):
            while publisher.get_subscription_count() == 0:
                await asyncio.sleep(.01)
        publisher.publish(value)
        return value.command_id if motion else None

    async def _acceptances(self, stream):
        try:
            while True:
                status = await stream.next()
                if status.owner != self.owner:
                    continue
                for _, futures in self.motion_pending.values():
                    future = futures.get(status.command_id)
                    if future and not future.done():
                        future.set_result(status)
        except asyncio.CancelledError:
            pass

    async def accepted(self, operation, command_id=None):
        """Managed-motion protocol: acceptance does not establish arrival."""
        if command_id is None:
            raise ValueError("accepted requires (operation, command_id); use the ID returned by publish(operation, payload)")
        if operation not in self.motion_pending or command_id not in self.motion_pending[operation][1]:
            raise ValueError(f"no pending command {command_id} for {operation} in this invocation")
        future = self.motion_pending[operation][1][command_id]
        async with asyncio.timeout(self.catalog[operation].get("timeout_s", 10)):
            result = await asyncio.shield(future)
        self.motion_pending[operation][1].pop(command_id, None)
        if not result.accepted:
            raise RuntimeError(result.message)
        return result

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
        service = self.node.create_service(cls, endpoint, invoke, callback_group=ReentrantCallbackGroup())
        self.services.append(service)
        return endpoint

    def transforms(self):
        if self.tf is None:
            from kinex.host.frame_graph import listen
            self.tf, self.tf_listener = listen(self.node)
            if self.world_stamp is not None:
                self.tf.observe_clock(self.world_stamp)
        return self.tf

    async def cleanup_owned(self, *, failed=True):
        if not failed:
            for request_id, cancellation in list(self.waits.items()):
                await self._request(cancellation, {"owner": self.owner, "request_id": request_id}, 2)
            return
        failures = []
        cancelled = set()
        for name, spec in self.catalog.items():
            if name.split(".", 1)[0] not in self.enrolled:
                continue
            motion, cancellation = spec.get("motion"), spec.get("cancellation")
            try:
                if motion and failed:
                    await self._request({"endpoint": motion["stop"], "type": "kinex_interfaces/srv/Stop"},
                                        {"owner": self.owner}, 2)
                if cancellation and cancellation["endpoint"] not in cancelled:
                    cancelled.add(cancellation["endpoint"])
                    await self._request(cancellation, {"owner": self.owner, "request_id": ""}, 2)
            except Exception as error:
                failures.append(error)
        if failures:
            raise ExceptionGroup("owned resource cleanup failed", failures)

    async def __aexit__(self, kind, error, traceback):
        succeeded = error is None or isinstance(error, SystemExit) and error.code in (None, 0)
        try:
            if succeeded:
                for operation, (_, pending) in self.motion_pending.items():
                    for command_id in list(pending):
                        await self.accepted(operation, command_id)
                if self.motion_error:
                    raise self.motion_error
                await self.cleanup_owned(failed=False)
            else:
                try:
                    await self.cleanup_owned()
                except Exception as cleanup:
                    error.add_note(f"motion cleanup failed: {cleanup}")
        except BaseException:
            if succeeded:
                await self.cleanup_owned()
            raise
        finally:
            self.closed = True
            for future in tuple(self.pending):
                future.cancel()
            handlers = tuple(self.handlers)
            for handler in handlers:
                handler.cancel()
            await asyncio.gather(*(asyncio.wrap_future(handler) for handler in handlers), return_exceptions=True)
            for task, _ in self.motion_pending.values():
                task.cancel()
            await asyncio.gather(*(task for task, _ in self.motion_pending.values()), return_exceptions=True)
            for stream in tuple(self.subscriptions):
                stream.close()
            if self.tf is not None:
                self.tf_listener.unregister()
            await asyncio.to_thread(self.executor.shutdown, timeout_sec=2)
            for node in self.extra_nodes:
                node.destroy_node()
            self.node.destroy_node()
            self.context.try_shutdown()
            await asyncio.to_thread(self.thread.join, 2)
            if _active.get() is self:
                _active.reset(self.token)


def communication(catalog=None, *, owner=None, domain_id=None):
    return Communication(catalog, owner=owner, domain_id=domain_id)

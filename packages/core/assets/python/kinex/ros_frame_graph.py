"""Kinex-owned tf2 history and the world's relative-transform service."""
import math
import threading

from kinex_interfaces.srv import LookupTransform
from rclpy.callback_groups import ReentrantCallbackGroup
from rclpy.clock import Clock as RosClock, ClockType
from rclpy.node import Node
from rclpy.time import Time
from rosgraph_msgs.msg import Clock
from tf2_ros import Buffer, TransformException, TransformListener

from kinex.communication import qos
from kinex.ros_frames import dynamic_qos


def nanoseconds(stamp):
    return stamp.sec * 1_000_000_000 + stamp.nanosec


class FrameBuffer(Buffer):
    def __init__(self):
        super().__init__()
        self.fixed = {}
        self.latest = {}
        self.future = {}
        self.clock_stamp = None
        self.lock = threading.RLock()

    def set_transform_static(self, value, authority):
        with self.lock:
            self.fixed[value.child_frame_id] = (value, authority)
            super().set_transform_static(value, authority)

    def set_transform(self, value, authority):
        with self.lock:
            if self.clock_stamp is not None and nanoseconds(value.header.stamp) > self.clock_stamp:
                self.future[value.child_frame_id] = (value, authority)
                return
            self.future.pop(value.child_frame_id, None)
            self.latest[value.child_frame_id] = (value, authority)
            super().set_transform(value, authority)

    def observe_clock(self, stamp):
        with self.lock:
            if self.clock_stamp is None or stamp < self.clock_stamp:
                super().clear()
                self.future.clear()
                # Mounts remain valid across reset. Preserve a reset sample that
                # arrived before its clock callback; discard the previous epoch.
                self.latest = {key: item for key, item in self.latest.items()
                               if nanoseconds(item[0].header.stamp) <= stamp}
                for value, authority in self.fixed.values():
                    super().set_transform_static(value, authority)
                for value, authority in self.latest.values():
                    super().set_transform(value, authority)
            self.clock_stamp = stamp
            # Clock and TF are separate DDS streams. Hold a sample that arrives
            # ahead of its clock; it must not make future/old-epoch poses visible.
            for value, authority in list(self.future.values()):
                if nanoseconds(value.header.stamp) <= stamp:
                    self.set_transform(value, authority)


def listen(node):
    buffer = FrameBuffer()
    return buffer, TransformListener(buffer, node, qos=dynamic_qos())


class FrameGraphNode(Node):
    def __init__(self, profile, context):
        super().__init__(profile["name"] + "_frames", context=context)
        self.buffer, self.listener = listen(self)
        self.stamp = None
        self.pending = set()
        self.calls = ReentrantCallbackGroup()
        self.watchdog_clock = RosClock(clock_type=ClockType.STEADY_TIME)
        operation = profile["operations"]["time"]
        self.create_subscription(Clock, operation["endpoint"], self.clock, qos(operation))
        self.create_service(LookupTransform, profile["operations"]["lookup_transform"]["endpoint"],
                            self.lookup, callback_group=self.calls)

    def clock(self, message):
        stamp = nanoseconds(message.clock)
        if self.stamp is not None and stamp < self.stamp:
            for future in tuple(self.pending):
                if not future.done():
                    future.set_exception(RuntimeError("world clock reset during transform lookup"))
        self.buffer.observe_clock(stamp)
        self.stamp = stamp

    async def lookup(self, request, response):
        future, timer = None, None
        try:
            if not math.isfinite(request.wait_s) or not 0 <= request.wait_s <= 30:
                raise ValueError("transform wait_s must be finite and within 0..30 seconds")
            if request.wait_s:
                if len(self.pending) >= 32:
                    raise RuntimeError("too many pending transform lookups")
                future = self.buffer.wait_for_transform_async(
                    request.target_frame, request.source_frame, Time.from_msg(request.stamp))
                self.pending.add(future)

                def expired():
                    if not future.done():
                        future.set_exception(TimeoutError("transform lookup timed out"))

                timer = self.create_timer(request.wait_s, expired, clock=self.watchdog_clock,
                                          callback_group=self.calls)
                await future
            response.transform = self.buffer.lookup_transform(
                request.target_frame, request.source_frame, Time.from_msg(request.stamp))
            response.success = True
        except (TransformException, ValueError, RuntimeError, TimeoutError) as error:
            response.message = str(error)
        finally:
            if timer is not None:
                self.destroy_timer(timer)
            if future is not None:
                self.pending.discard(future)
        return response

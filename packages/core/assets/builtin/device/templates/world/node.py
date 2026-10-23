"""Real-world clock: system time on `time`, owner-scoped waits on `wait`."""
from collections import deque
import math

from kinex_interfaces.srv import CancelWait, Wait
from rclpy.callback_groups import ReentrantCallbackGroup
from rclpy.node import Node
from rclpy.task import Future
from rosgraph_msgs.msg import Clock

from kinex.communication import qos
from kinex.node import node_name

PERIOD_S = .01  # World time resolution and wait completion granularity.


class WallClock(Node):
    def __init__(self, profile, context):
        # The world clock is the source of the global /clock remap, never its consumer.
        super().__init__(node_name(profile), context=context, use_global_arguments=False)
        time, wait = profile["operations"]["time"], profile["operations"]["wait"]
        self.waits = {}
        self.cancelled = deque(maxlen=4096)
        self.retired = deque(maxlen=1024)
        self.clock = self.create_publisher(Clock, time["endpoint"], qos(time))
        # Pending waits suspend their callbacks; cancellation and ticks must still run.
        group = ReentrantCallbackGroup()
        self.create_service(Wait, wait["endpoint"], self.wait, callback_group=group)
        self.create_service(CancelWait, wait["cancellation"]["endpoint"], self.cancel, callback_group=group)
        self.create_timer(PERIOD_S, self.tick, callback_group=group)

    def tick(self):
        now = self.get_clock().now()
        self.clock.publish(Clock(clock=now.to_msg()))
        # Completing after publishing makes every wait, including zero, a barrier.
        for key, (deadline, _) in list(self.waits.items()):
            if deadline <= now.nanoseconds:
                self.finish(key, True, "")

    async def wait(self, request, response):
        key = (request.owner, request.request_id)
        if not all(key) or key in self.waits or key in self.cancelled or request.owner in self.retired:
            response.message = "wait requires a fresh owner and request ID"
        elif not math.isfinite(request.duration_s) or request.duration_s < 0:
            response.message = "duration_s must be finite and nonnegative"
        else:
            start = self.get_clock().now().nanoseconds
            done = Future(executor=self.executor)
            self.waits[key] = (start + round(request.duration_s * 1e9), done)
            response.success, response.message = await done
            end = self.get_clock().now().nanoseconds
            response.time_s, response.waited_s = end / 1e9, (end - start) / 1e9
        return response

    def cancel(self, request, response):
        # Tombstones reject waits that arrive after their cancellation.
        if request.request_id:
            self.cancelled.append((request.owner, request.request_id))
        else:
            self.retired.append(request.owner)
        for owner, request_id in list(self.waits):
            if owner == request.owner and request.request_id in ("", request_id):
                self.finish((owner, request_id), False, "cancelled")
        response.success = True
        return response

    def finish(self, key, success, message):
        self.waits.pop(key)[1].set_result((success, message))


def create(profile, context):
    return WallClock(profile, context)

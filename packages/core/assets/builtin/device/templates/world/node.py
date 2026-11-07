"""Real-world clock: system time on `time`, one pending wait on `wait`, cancelled by `stop`."""
import math

from kinex_interfaces.srv import Wait
from rclpy.callback_groups import ReentrantCallbackGroup
from rclpy.node import Node
from rclpy.task import Future
from rosgraph_msgs.msg import Clock
from std_srvs.srv import Trigger

from kinex.communication import qos
from kinex.node import node_name

PERIOD_S = .01  # World time resolution and wait completion granularity.


class WallClock(Node):
    def __init__(self, profile, context):
        # The world clock is the source of the global /clock remap, never its consumer.
        super().__init__(node_name(profile), context=context, use_global_arguments=False)
        operations = profile["operations"]
        self.pending = None  # (deadline_ns, future) of the wait in progress
        self.clock = self.create_publisher(Clock, operations["time"]["endpoint"], qos(operations["time"]))
        # A pending wait suspends its callback; stop and ticks must still run.
        group = ReentrantCallbackGroup()
        self.create_service(Wait, operations["wait"]["endpoint"], self.wait, callback_group=group)
        self.create_service(Trigger, operations["stop"]["endpoint"], self.stop, callback_group=group)
        self.create_timer(PERIOD_S, self.tick, callback_group=group)

    def tick(self):
        now = self.get_clock().now()
        self.clock.publish(Clock(clock=now.to_msg()))
        # Completing after publishing makes every wait, including zero, a barrier.
        if self.pending and self.pending[0] <= now.nanoseconds:
            self.finish(True, "")

    async def wait(self, request, response):
        if self.pending:
            response.message = "another wait is pending; world waits are sequential"
        elif not math.isfinite(request.duration_s) or request.duration_s < 0:
            response.message = "duration_s must be finite and nonnegative"
        else:
            start = self.get_clock().now().nanoseconds
            done = Future(executor=self.executor)
            self.pending = (start + round(request.duration_s * 1e9), done)
            response.success, response.message = await done
            end = self.get_clock().now().nanoseconds
            response.time_s, response.waited_s = end / 1e9, (end - start) / 1e9
        return response

    def stop(self, request, response):
        if self.pending:
            self.finish(False, "cancelled by stop")
        response.success = True
        return response

    def finish(self, success, message):
        done = self.pending[1]
        self.pending = None
        done.set_result((success, message))


def create(profile, context):
    return WallClock(profile, context)

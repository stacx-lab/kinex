"""The real world: system time on the domain's /clock, and the operations every world serves. Time passes by
itself here, so a wait only watches the clock; goals end with their devices, which tell whoever awaits them."""
import math

from custom_interfaces.srv import Now, Wait
from rclpy.callback_groups import ReentrantCallbackGroup
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, QoSProfile
from rclpy.task import Future
from rosgraph_msgs.msg import Clock
from std_srvs.srv import Trigger

from kinex.node import node_name

PERIOD_S = .01  # World time resolution: how finely a wait ends.


class World(Node):
    def __init__(self, profile, context):
        # The world is the source of the domain's /clock, never its consumer.
        super().__init__(node_name(profile), context=context, use_global_arguments=False)
        operations = profile["operations"]
        self.pending = None  # (the time the wait is over, the future of its end)
        self.clock = self.create_publisher(Clock, "/clock", QoSProfile(depth=1, durability=DurabilityPolicy.TRANSIENT_LOCAL))
        # A pending wait suspends its callback; stop and ticks must still run.
        group = ReentrantCallbackGroup()
        self.create_service(Now, operations["now"]["endpoint"], self.now, callback_group=group)
        self.create_service(Wait, operations["wait"]["endpoint"], self.wait, callback_group=group)
        self.create_service(Trigger, operations["stop"]["endpoint"], self.stop, callback_group=group)
        self.create_timer(PERIOD_S, self.tick, callback_group=group)

    def time_ns(self):
        return self.get_clock().now().nanoseconds

    def tick(self):
        self.clock.publish(Clock(clock=self.get_clock().now().to_msg()))
        # Settling after publishing makes every wait, one of no seconds included, a barrier.
        if self.pending and self.time_ns() >= self.pending[0]:
            self.finish(True, "ok")

    def now(self, request, response):
        # The real world has no budget.
        response.time_s, response.used_s, response.max_s = self.time_ns() / 1e9, math.nan, math.nan
        return response

    async def wait(self, request, response):
        if self.pending:
            response.message = "another wait is pending; world waits are sequential"
        elif math.isnan(request.seconds) or request.seconds < 0:
            response.message = "seconds must be nonnegative"
        else:
            # Infinite seconds wait until the stop: whoever awaits a goal alone stops the wait once it has ended.
            end = self.time_ns() + request.seconds * 1e9
            self.pending = end, Future(executor=self.executor)
            response.success, response.message = await self.pending[1]
        response.time_s = self.time_ns() / 1e9
        return response

    def stop(self, request, response):
        if self.pending:
            self.finish(False, "cancelled")
        response.success = True
        return response

    def finish(self, success, message):
        (_, done), self.pending = self.pending, None
        done.set_result((success, message))


def create(profile, context):
    return World(profile, context)

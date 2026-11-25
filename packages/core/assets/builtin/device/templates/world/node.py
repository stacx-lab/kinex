"""The real world: system time on the domain's /clock, and the operations every world serves. Time passes by
itself here, so a wait only watches the clock and the goals it names."""
from functools import partial
import math

from action_msgs.msg import GoalStatus, GoalStatusArray
from custom_interfaces.srv import Now, Wait
from rclpy.callback_groups import ReentrantCallbackGroup
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, QoSProfile
from rclpy.task import Future
from rosgraph_msgs.msg import Clock
from std_srvs.srv import Trigger

from kinex.node import node_name

PERIOD_S = .01  # World time resolution: how finely a wait ends.
LATCHED = QoSProfile(depth=1, durability=DurabilityPolicy.TRANSIENT_LOCAL)
STATUS = "action_msgs/msg/GoalStatusArray"
EXECUTING = (GoalStatus.STATUS_ACCEPTED, GoalStatus.STATUS_EXECUTING, GoalStatus.STATUS_CANCELING)


class World(Node):
    def __init__(self, profile, context):
        # The world is the source of the domain's /clock, never its consumer.
        super().__init__(node_name(profile), context=context, use_global_arguments=False)
        operations = profile["operations"]
        self.pending = None  # (first, the time each of seconds is over, goals, the time of its timeout, future)
        self.executing, self.watched = {}, set()  # goal id -> whether its action server reports it executing
        self.clock = self.create_publisher(Clock, "/clock", LATCHED)
        # A pending wait suspends its callback; stop and ticks must still run.
        group = ReentrantCallbackGroup()
        self.create_service(Now, operations["now"]["endpoint"], self.now, callback_group=group)
        self.create_service(Wait, operations["wait_all"]["endpoint"], partial(self.wait, False), callback_group=group)
        self.create_service(Wait, operations["wait_any"]["endpoint"], partial(self.wait, True), callback_group=group)
        self.create_service(Trigger, operations["stop"]["endpoint"], self.stop, callback_group=group)
        self.create_timer(PERIOD_S, self.tick, callback_group=group)
        self.create_timer(1., self.watch, callback_group=group)

    def time_ns(self):
        return self.get_clock().now().nanoseconds

    def watch(self):
        """Follow every action server's goals: a wait is told that a goal has finished by its server's status."""
        for topic, types in self.get_topic_names_and_types():
            if STATUS in types and topic not in self.watched:
                self.watched.add(topic)
                self.create_subscription(GoalStatusArray, topic, self.statuses, LATCHED)

    def statuses(self, message):
        for entry in message.status_list:
            self.executing[bytes(entry.goal_info.goal_id.uuid)] = entry.status in EXECUTING

    def tick(self):
        self.clock.publish(Clock(clock=self.get_clock().now().to_msg()))
        # Settling after publishing makes every wait, one with nothing left included, a barrier.
        self.settle()

    def now(self, request, response):
        # The real world has no budget.
        response.time_s, response.used_s, response.max_s = self.time_ns() / 1e9, math.nan, math.nan
        return response

    async def wait(self, first, request, response):
        if self.pending:
            response.message = "another wait is pending; world waits are sequential"
        elif not all(math.isfinite(value) and value >= 0 for value in (*request.seconds, request.timeout)):
            response.message = "seconds and timeout must be finite and nonnegative"
        elif first and not (request.seconds or request.goals):
            response.message = "wait_any needs an entry to wait for"
        else:
            self.watch()
            start, done = self.time_ns(), Future(executor=self.executor)
            self.pending = (first, [start + round(value * 1e9) for value in request.seconds],
                            [bytes(goal.uuid) for goal in request.goals],
                            start + round(request.timeout * 1e9) if request.timeout else math.inf, done)
            response.success, response.message, response.elapsed, response.finished, response.timed_out = await done
        response.time_s = self.time_ns() / 1e9
        return response

    def over(self):
        """Whether each of the pending wait's seconds and goals is over. A goal no server reports is taken as
        executing: its status may yet arrive."""
        _, ends, goals, _, _ = self.pending
        now = self.time_ns()
        return [now >= end for end in ends], [not self.executing.get(goal, True) for goal in goals]

    def settle(self):
        if self.pending:
            elapsed, finished = self.over()
            met = (any if self.pending[0] else all)([*elapsed, *finished])
            if met or self.time_ns() >= self.pending[3]:
                self.finish(True, "ok", not met)

    def stop(self, request, response):
        if self.pending:
            self.finish(False, "cancelled")
        response.success = True
        return response

    def finish(self, success, message, timed_out=False):
        (*_, done), entries, self.pending = self.pending, self.over(), None
        done.set_result((success, message, *entries, timed_out))


def create(profile, context):
    return World(profile, context)

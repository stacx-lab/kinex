"""Reference locomotion node adapting an existing ROS base driver to the Kinex locomotion contract.

Set CMD_VEL, BODY_POSE and ODOM to the driver's Twist, Pose and Odometry topics,
MODE_STATE to its String mode topic with MODES mapping its mode names to the
profile's, and ENTER to the std_srvs/Trigger service that enters each mode. The node
accepts only what the current mode declares, re-sends velocity until a command's
duration ends because drivers drop stale commands, and on stop sends zero velocity
while keeping the mode and posture.
"""
import asyncio

from geometry_msgs.msg import Pose, Twist
from nav_msgs.msg import Odometry
from rclpy.duration import Duration
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from std_msgs.msg import String
from std_srvs.srv import Trigger

from kinex.communication import qos
from kinex.lib.locomotion import accepted, posture, transition, velocity
from kinex.node import motion_service, node_name

CMD_VEL = "/cmd_vel"
BODY_POSE = "/body_pose"
ODOM = "/odom"
MODE_STATE = "/robot/mode"
MODES = {"balance_stand": "standing", "lie_down": "crouched"}
ENTER = {"standing": "/robot/stand_up", "crouched": "/robot/stand_down"}
RATE_HZ = 20


class Locomotion(Node):
    def __init__(self, profile, context):
        super().__init__(node_name(profile), context=context)
        self.profile, self.mode, self.odometry = profile, None, None
        self.twist, self.until = Twist(), None
        operations = profile["operations"]
        self.cmd_vel = self.create_publisher(Twist, CMD_VEL, 10)
        self.body_pose = self.create_publisher(Pose, BODY_POSE, 10)
        self.enter = {mode: self.create_client(Trigger, service) for mode, service in ENTER.items()}
        self.mode_state = self.create_publisher(String, operations["mode"]["endpoint"], qos(operations["mode"]))
        self.odometry_state = self.create_publisher(Odometry, operations["odometry"]["endpoint"], qos(operations["odometry"]))
        self.create_subscription(Odometry, ODOM, self.receive_odometry, qos_profile_sensor_data)
        self.create_subscription(String, MODE_STATE, self.receive_mode, qos_profile_sensor_data)
        commands = {"velocity": self.drive, "posture": self.pose, "mode_target": self.change}
        motion_service(self, operations, {name: apply for name, apply in commands.items() if name in operations}, self.halt)
        self.create_timer(1 / RATE_HZ, self.tick)

    def receive_odometry(self, message):
        # Odometry is dead-reckoned in the device's own odom frame, never a global pose.
        message.header.frame_id, message.child_frame_id = f"{self.profile['name']}/odom", f"{self.profile['name']}/base"
        self.odometry = message
        self.odometry_state.publish(message)

    def receive_mode(self, message):
        mode = MODES.get(message.data)
        if mode is None:
            self.get_logger().warning(f"driver reports unmapped mode {message.data!r}")
        elif mode != self.mode:
            # A mode change, commanded or not, ends any velocity command.
            self.mode = mode
            self.halt()
            self.mode_state.publish(String(data=mode))

    def drive(self, message):
        accepted(self.profile, self.mode, "velocity")
        velocity(self.profile, message.twist)
        if not 0 < message.duration_s < float("inf"):
            raise ValueError("duration_s must be positive and finite")
        self.twist = message.twist
        self.until = self.get_clock().now() + Duration(seconds=message.duration_s)
        self.cmd_vel.publish(self.twist)

    def tick(self):
        if self.until is None:
            return
        if self.get_clock().now() < self.until:
            self.cmd_vel.publish(self.twist)
        else:
            self.halt()

    def halt(self):
        self.until = None
        self.cmd_vel.publish(Twist())

    def pose(self, message):
        accepted(self.profile, self.mode, "posture")
        posture(self.profile, message.pose)
        self.body_pose.publish(message.pose)

    def change(self, message):
        transition(self.profile, self.mode, message.mode)
        client = self.enter.get(message.mode)
        if client is None or not client.service_is_ready():
            raise RuntimeError(f"the driver cannot enter {message.mode}")
        self.halt()
        client.call_async(Trigger.Request())

    async def ready(self):
        while self.mode is None or self.odometry is None:
            await asyncio.sleep(.02)


def create(profile, context):
    return Locomotion(profile, context)

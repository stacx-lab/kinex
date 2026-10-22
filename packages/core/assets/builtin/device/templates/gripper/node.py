"""Reference gripper node adapting an existing ROS gripper driver to the Kinex grip contract.

Set STATE to the driver's JointState topic and COMMAND to its Float64 grip position
topic, both in URDF joint units, and GRASPED to its object-detection topic when it
has one. This node republishes measured joints, serves owned grip targets and
holds the measured posture on stop.
"""
import asyncio

from rclpy.node import Node
from sensor_msgs.msg import JointState
from std_msgs.msg import Bool, Float64

from kinex.communication import qos
from kinex.ownership import motion_service

STATE = "/gripper/joint_states"
COMMAND = "/gripper/position_command"
GRASPED = "/gripper/object_detected"


class Gripper(Node):
    def __init__(self, profile, context):
        super().__init__("kinex_" + profile["name"], context=context)
        grip = profile["grip"]
        self.joint, self.range = grip["joint"], sorted((grip["open"], grip["closed"]))
        self.position = None
        operations = profile["operations"]
        state = operations["joint_state"]
        self.state = self.create_publisher(JointState, state["endpoint"], qos(state))
        self.create_subscription(JointState, STATE, self.receive, qos(state))
        self.command = self.create_publisher(Float64, COMMAND, 10)
        motion_service(self, operations["target"], self.apply, self.hold)
        if "grasped" in operations:
            grasped = self.create_publisher(Bool, operations["grasped"]["endpoint"], qos(operations["grasped"]))
            self.create_subscription(Bool, GRASPED, grasped.publish, qos(operations["grasped"]))

    def receive(self, message):
        self.position = dict(zip(message.name, message.position)).get(self.joint, self.position)
        self.state.publish(message)

    def apply(self, message):
        if not self.range[0] <= message.target <= self.range[1]:
            raise ValueError(f"target must lie between open and closed {self.range}")
        self.command.publish(Float64(data=message.target))

    def hold(self):
        # Hold the measured posture: a stop never opens or closes the fingers.
        if self.position is not None:
            self.command.publish(Float64(data=self.position))

    async def ready(self):
        while self.position is None:
            await asyncio.sleep(.02)


def create(profile, context):
    return Gripper(profile, context)

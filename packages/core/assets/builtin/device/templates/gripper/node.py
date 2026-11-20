"""Reference gripper node adapting an existing ROS gripper driver to the Kinex grip contract.

Set STATE to the driver's JointState topic and COMMAND to its Float64 grip position
topic, both in URDF joint units, and GRASPED to its object-detection topic when it
has one. This node republishes measured joints and forwards grip targets. A stop
keeps the last applied target, so a held object stays gripped; before the first
target it holds the measured posture.
"""
import asyncio

from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import JointState
from std_msgs.msg import Bool, Float64

from kinex.communication import qos
from kinex.node import command_service, node_name

STATE = "/gripper/joint_states"
COMMAND = "/gripper/position_command"
GRASPED = "/gripper/object_detected"


class Gripper(Node):
    def __init__(self, profile, context):
        super().__init__(node_name(profile), context=context)
        grip = profile["grip"]
        self.joint, self.range = grip["joint"], sorted((grip["open"], grip["closed"]))
        self.position = self.applied = None
        operations = profile["operations"]
        state = operations["joint_state"]
        self.state = self.create_publisher(JointState, state["endpoint"], qos(state))
        self.create_subscription(JointState, STATE, self.receive, qos_profile_sensor_data)
        self.command = self.create_publisher(Float64, COMMAND, 10)
        command_service(self, operations, {"target": self.apply}, self.hold)
        if "grasped" in operations:
            grasped = self.create_publisher(Bool, operations["grasped"]["endpoint"], qos(operations["grasped"]))
            self.create_subscription(Bool, GRASPED, grasped.publish, qos_profile_sensor_data)

    def receive(self, message):
        self.position = dict(zip(message.name, message.position)).get(self.joint, self.position)
        self.state.publish(message)

    def apply(self, message):
        if not self.range[0] <= message.data <= self.range[1]:
            raise ValueError(f"target must lie between open and closed {self.range}")
        self.command.publish(message)
        self.applied = message.data

    def hold(self):
        # Keep the applied grip target, never the measured aperture, which would release a held object;
        # before the first target, hold the measured posture so a stop never closes the fingers.
        hold = self.position if self.applied is None else self.applied
        if hold is not None:
            self.command.publish(Float64(data=hold))

    async def ready(self):
        while self.position is None:
            await asyncio.sleep(.02)


def create(profile, context):
    return Gripper(profile, context)

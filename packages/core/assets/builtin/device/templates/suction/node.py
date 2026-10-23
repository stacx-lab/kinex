"""Reference suction node adapting an existing ROS vacuum gripper driver to the Kinex suction contract.

Set SWITCH to the driver's std_srvs/SetBool on/off service, DETECTED to its
object-detection Bool topic and PRESSURE to its FluidPressure topic. This binary
node switches vacuum on for target 1 and off for 0, republishes detection and
pressure, and keeps the vacuum state on stop.
"""
import asyncio

from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import FluidPressure
from std_msgs.msg import Bool
from std_srvs.srv import SetBool

from kinex.communication import qos
from kinex.node import motion_service, node_name

SWITCH = "/vacuum_gripper/grip_cmd"
DETECTED = "/vacuum_gripper/object_detected"
PRESSURE = "/vacuum_gripper/pressure"


class Suction(Node):
    def __init__(self, profile, context):
        super().__init__(node_name(profile), context=context)
        self.detected = None
        operations = profile["operations"]
        self.switch = self.create_client(SetBool, SWITCH)
        grasped = operations["grasped"]
        self.grasped = self.create_publisher(Bool, grasped["endpoint"], qos(grasped))
        self.create_subscription(Bool, DETECTED, self.receive, qos_profile_sensor_data)
        if "pressure" in operations:
            pressure = operations["pressure"]
            publisher = self.create_publisher(FluidPressure, pressure["endpoint"], qos(pressure))
            self.create_subscription(FluidPressure, PRESSURE, publisher.publish, qos_profile_sensor_data)
        # The vacuum state persists, so a stop has nothing to hold: it never releases an object.
        motion_service(self, operations, {"target": self.apply}, hold=lambda: None)

    def receive(self, message):
        self.detected = message.data
        self.grasped.publish(message)

    def apply(self, message):
        if message.target not in (0., 1.):
            raise ValueError("binary suction targets are 0 (release) or 1 (full vacuum)")
        if not self.switch.service_is_ready():
            raise RuntimeError("the vacuum driver's switch service is unavailable")
        self.switch.call_async(SetBool.Request(data=message.target == 1.))

    async def ready(self):
        while self.detected is None or not self.switch.service_is_ready():
            await asyncio.sleep(.02)


def create(profile, context):
    return Suction(profile, context)

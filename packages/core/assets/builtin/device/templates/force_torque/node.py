"""Reference force_torque node adapting an existing ROS F/T driver to the Kinex wrench contract.

Set SOURCE to the driver's WrenchStamped topic in the measurement frame. This node
subtracts the profile bias and any runtime zero, publishes NaN for unmeasured axes
and keeps the driver's acquisition stamps.
"""
import asyncio
import math

from geometry_msgs.msg import WrenchStamped
from rclpy.node import Node
from std_srvs.srv import Trigger

from kinex.communication import qos

SOURCE = "/ft_sensor/wrench"
CHANNELS = ("force", "torque")


class ForceTorque(Node):
    def __init__(self, profile, context):
        super().__init__("kinex_" + profile["name"], context=context)
        self.frame = profile["name"] + "/base"
        measurement = profile["measurement"]
        self.bias = {}
        for channel in CHANNELS:
            bias = (measurement[channel] or {}).get("bias", {})
            if bias == "???":
                raise ValueError(f"record the {channel} bias; use zeros until it is calibrated")
            self.bias[channel] = bias
        self.offset = {channel: dict.fromkeys(self.bias[channel], 0.) for channel in CHANNELS}
        self.latest = None
        wrench = profile["operations"]["wrench"]
        self.wrench = self.create_publisher(WrenchStamped, wrench["endpoint"], qos(wrench))
        self.create_subscription(WrenchStamped, SOURCE, self.receive, qos(wrench))
        if "zero" in profile["operations"]:
            self.create_service(Trigger, profile["operations"]["zero"]["endpoint"], self.zero)

    def receive(self, message):
        message.header.frame_id = self.frame
        for channel in CHANNELS:
            vector = getattr(message.wrench, channel)
            for axis in "xyz":
                bias = self.bias[channel].get(axis)
                value = math.nan if bias is None else getattr(vector, axis) - bias - self.offset[channel][axis]
                setattr(vector, axis, value)
        self.latest = message
        self.wrench.publish(message)

    def zero(self, request, response):
        # The latest corrected reading becomes zero; the profile bias is unchanged.
        for channel in CHANNELS:
            vector = getattr(self.latest.wrench, channel)
            for axis in self.offset[channel]:
                self.offset[channel][axis] += getattr(vector, axis)
        response.success = True
        return response

    async def ready(self):
        while self.latest is None:
            await asyncio.sleep(.02)


def create(profile, context):
    return ForceTorque(profile, context)

"""Reference imu node adapting an existing ROS IMU driver to the Kinex inertial contract.

Set SOURCE to the driver's Imu topic and MAGNETIC to its MagneticField topic, both
in the measurement frame. This node subtracts the profile bias, marks channels the
profile does not provide per REP-145 with NaN values, and keeps the driver's
acquisition stamps.
"""
import asyncio
import math

from rclpy.node import Node
from sensor_msgs.msg import Imu, MagneticField

from kinex.communication import qos

SOURCE = "/imu/data"
MAGNETIC = "/imu/mag"
VECTORS = ("angular_velocity", "linear_acceleration")


def bias(channel, name):
    if channel is None:
        return None
    if channel["bias"] == "???":
        raise ValueError(f"record the {name} bias; use zeros until it is calibrated")
    return channel["bias"]


def correct(vector, offsets):
    for axis in "xyz":
        value = getattr(vector, axis) - offsets[axis] if axis in offsets else math.nan
        setattr(vector, axis, value)


class InertialSensor(Node):
    def __init__(self, profile, context):
        super().__init__("kinex_" + profile["name"], context=context)
        self.frame = profile["name"] + "/base"
        measurement = profile["measurement"]
        self.bias = {name: bias(measurement[name], name) for name in (*VECTORS, "magnetic_field")}
        self.orientation = measurement["orientation"] is not None
        self.latest = None
        imu = profile["operations"]["imu"]
        self.imu = self.create_publisher(Imu, imu["endpoint"], qos(imu))
        self.create_subscription(Imu, SOURCE, self.receive, qos(imu))
        if "magnetic_field" in profile["operations"]:
            magnetic = profile["operations"]["magnetic_field"]
            self.magnetic = self.create_publisher(MagneticField, magnetic["endpoint"], qos(magnetic))
            self.create_subscription(MagneticField, MAGNETIC, self.receive_magnetic, qos(magnetic))

    def receive(self, message):
        message.header.frame_id = self.frame
        for name in VECTORS:
            correct(getattr(message, name), self.bias[name] or {})
            if self.bias[name] is None:
                getattr(message, name + "_covariance")[0] = -1.0
        if not self.orientation:
            orientation = message.orientation
            orientation.x = orientation.y = orientation.z = orientation.w = math.nan
            message.orientation_covariance[0] = -1.0
        self.latest = message
        self.imu.publish(message)

    def receive_magnetic(self, message):
        message.header.frame_id = self.frame
        correct(message.magnetic_field, self.bias["magnetic_field"] or {})
        self.magnetic.publish(message)

    async def ready(self):
        while self.latest is None:
            await asyncio.sleep(.02)


def create(profile, context):
    return InertialSensor(profile, context)

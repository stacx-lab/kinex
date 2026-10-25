"""Reference rgbd node adapting an existing ROS RGB-D driver to the Kinex camera contract.

Set COLOR to the driver's rgb8 topic and DEPTH to its 16UC1 depth registered to
the color grid, both from one acquisition with equal stamps. This node publishes
both in the calibrated optical frame; a reader pairs `image` and `depth` by stamp.
"""
import asyncio

from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import Image

from kinex.communication import qos
from kinex.node import node_name

COLOR = "/camera/color/image_raw"
DEPTH = "/camera/aligned_depth_to_color/image_raw"


class Camera(Node):
    def __init__(self, profile, context):
        super().__init__(node_name(profile), context=context)
        self.frame = profile["name"] + "/base"
        self.latest = {"image": None, "depth": None}
        self.paired = False
        self.outputs = {}
        for name, source in (("image", COLOR), ("depth", DEPTH)):
            operation = profile["operations"][name]
            self.outputs[name] = self.create_publisher(Image, operation["endpoint"], qos(operation))
            self.create_subscription(Image, source, lambda message, name=name: self.receive(name, message), qos_profile_sensor_data)

    def receive(self, name, message):
        message.header.frame_id = self.frame
        self.latest[name] = message
        self.outputs[name].publish(message)
        image, depth = self.latest["image"], self.latest["depth"]
        if image is not None and depth is not None and image.header.stamp == depth.header.stamp:
            self.paired = True

    async def ready(self):
        # A loaded camera is streaming registered pairs: load waits for the first one.
        while not self.paired:
            await asyncio.sleep(.02)


def create(profile, context):
    return Camera(profile, context)

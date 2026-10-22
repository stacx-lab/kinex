"""Reference rgbd node adapting an existing ROS RGB-D driver to the Kinex camera contract.

Set COLOR to the driver's rgb8 topic and DEPTH to its 16UC1 depth registered to
the color grid, both from one acquisition with equal stamps. This node publishes
both in the calibrated optical frame and captures the latest matching pair.
"""
import asyncio

from kinex_interfaces.srv import CaptureRGBD
from rclpy.node import Node
from sensor_msgs.msg import Image

from kinex.communication import qos

COLOR = "/camera/color/image_raw"
DEPTH = "/camera/aligned_depth_to_color/image_raw"


class Camera(Node):
    def __init__(self, profile, context):
        super().__init__("kinex_" + profile["name"], context=context)
        self.frame = profile["name"] + "/base"
        self.latest = {"image": None, "depth": None}
        self.pair = None
        self.outputs = {}
        for name, source in (("image", COLOR), ("depth", DEPTH)):
            operation = profile["operations"][name]
            self.outputs[name] = self.create_publisher(Image, operation["endpoint"], qos(operation))
            self.create_subscription(Image, source, lambda message, name=name: self.receive(name, message), qos(operation))
        self.create_service(CaptureRGBD, profile["operations"]["capture"]["endpoint"], self.capture)

    def receive(self, name, message):
        message.header.frame_id = self.frame
        self.latest[name] = message
        self.outputs[name].publish(message)
        image, depth = self.latest["image"], self.latest["depth"]
        if image is not None and depth is not None and image.header.stamp == depth.header.stamp:
            self.pair = image, depth

    def capture(self, request, response):
        response.image, response.depth_image = self.pair
        return response

    async def ready(self):
        # Capture cannot report a missing pair, so load waits for the first one.
        while self.pair is None:
            await asyncio.sleep(.02)


def create(profile, context):
    return Camera(profile, context)

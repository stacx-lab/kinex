"""Reference rgb node adapting an existing ROS camera driver to the Kinex camera contract.

Set SOURCE to the driver's rgb8 image topic at the profile resolution. The driver
keeps acquisition and its stamps; this node publishes in the calibrated optical
frame, and a reader subscribes to `image` and takes the next frame.
"""
import asyncio

from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import Image

from kinex.communication import qos
from kinex.node import node_name

SOURCE = "/camera/image_raw"


class Camera(Node):
    def __init__(self, profile, context):
        super().__init__(node_name(profile), context=context)
        self.frame = profile["name"] + "/base"
        self.latest = None
        image = profile["operations"]["image"]
        self.image = self.create_publisher(Image, image["endpoint"], qos(image))
        self.create_subscription(Image, SOURCE, self.receive, qos_profile_sensor_data)

    def receive(self, message):
        message.header.frame_id = self.frame
        self.latest = message
        self.image.publish(message)

    async def ready(self):
        # A loaded camera is streaming: load waits for the first frame.
        while self.latest is None:
            await asyncio.sleep(.02)


def create(profile, context):
    return Camera(profile, context)

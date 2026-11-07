"""Reference rgb node adapting an existing ROS camera driver to the Kinex camera contract.

Map each image operation to the driver's rgb8 image topic at the profile resolution:
`image` for layout: mono, or `left_image` and `right_image` for layout: stereo. The
driver keeps acquisition and its stamps; this node publishes in the calibrated optical
frame, and a reader subscribes to the operation and takes the next frame.
"""
import asyncio
from functools import partial

from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import Image

from kinex.communication import qos
from kinex.node import node_name

SOURCES = {"image": "/camera/image_raw"}
# Stereo: SOURCES = {"left_image": "/stereo/left/image_raw", "right_image": "/stereo/right/image_raw"}
FRAMES = {"image": "base", "left_image": "left", "right_image": "right"}


class Camera(Node):
    def __init__(self, profile, context):
        super().__init__(node_name(profile), context=context)
        self.latest = {}
        for name, source in SOURCES.items():
            operation = profile["operations"][name]
            publisher = self.create_publisher(Image, operation["endpoint"], qos(operation))
            frame = f"{profile['name']}/{FRAMES[name]}"
            self.create_subscription(Image, source, partial(self.receive, name, publisher, frame), qos_profile_sensor_data)

    def receive(self, name, publisher, frame, message):
        message.header.frame_id = frame
        self.latest[name] = message
        publisher.publish(message)

    async def ready(self):
        # A loaded camera is streaming: load waits for a first frame from every source.
        while len(self.latest) < len(SOURCES):
            await asyncio.sleep(.02)


def create(profile, context):
    return Camera(profile, context)

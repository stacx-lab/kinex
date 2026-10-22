"""Measured URDF link frames on TF, independent of device drivers."""
import asyncio
from pathlib import Path

from rclpy.node import Node
from sensor_msgs.msg import JointState
from tf2_ros import StaticTransformBroadcaster, TransformBroadcaster

from kinex.communication import qos
from kinex.motion import flat
from kinex.ros_frames import dynamic_qos, frame_id, transform
from kinex.urdf import joint_transform, positions, read_tree


class LinkPublisher(Node):
    """Publish every URDF link below the device base from measured joints, mimics included."""

    def __init__(self, profile, context, directory):
        super().__init__(profile["name"].replace("-", "_") + "_links", context=context)
        model = profile["model"]
        self.tree = read_tree(Path(directory) / model["path"], model["base_link"])
        self.device, self.base = profile["name"], model["base_link"]
        self.moving = [joint for joint in self.tree["joints"] if joint["type"] != "fixed"]
        fixed = [self.transform(joint) for joint in self.tree["joints"] if joint["type"] == "fixed"]
        if fixed:
            self.static = StaticTransformBroadcaster(self)
            self.static.sendTransform(fixed)
        self.broadcaster = TransformBroadcaster(self, qos=dynamic_qos())
        self.observed = False
        state = profile["operations"]["joint_state"]
        self.create_subscription(JointState, state["endpoint"], self.state, qos(state))

    def frame(self, link):
        # The URDF base link is the device base; every other link keeps its name.
        return frame_id(self.device, None if link == self.base else link)

    def transform(self, joint, position=0.0, stamp=None):
        pose = flat(joint_transform(joint, position))
        return transform(self.frame(joint["parent"]), self.frame(joint["child"]), pose, stamp)

    def state(self, message):
        values = positions(self.tree, dict(zip(message.name, message.position)))
        self.broadcaster.sendTransform([self.transform(joint, values[joint["name"]], message.header.stamp)
                                        for joint in self.moving if joint["name"] in values])
        self.observed = True

    async def ready(self):
        while not self.observed:
            await asyncio.sleep(.02)

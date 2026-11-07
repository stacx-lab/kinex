"""Building blocks for device nodes: names, placement, commands, JSON services and URDF link frames."""
import asyncio
import json
import re
from pathlib import Path

from rclpy.node import Node
from sensor_msgs.msg import JointState
from tf2_ros import StaticTransformBroadcaster, TransformBroadcaster

from kinex.communication import qos
from kinex.lib.frames import dynamic_qos, frame_id, transform
from kinex.lib.geometry import flat
from kinex.lib.urdf import joint_transform, positions, read_tree


def node_name(profile, suffix=""):
    """A legal ROS node name for the device: kinex_<name>[_<suffix>] with other characters as _."""
    return re.sub(r"[^A-Za-z0-9_]", "_", "_".join(filter(None, ("kinex", profile["name"], suffix))))


def placement(compute, supported=("cpu", "cuda", "mps")):
    """The torch device string for a model's declared compute."""
    if compute["kind"] not in supported:
        raise ValueError(f"this model runs on {' or '.join(supported)}, not {compute['kind']}")
    return f"cuda:{compute['index']}" if compute["kind"] == "cuda" else compute["kind"]


def command_service(node, operations, commands, hold):
    """Route input topics to their handlers and serve the device's Trigger stop as hold().

    commands maps each operation name to apply(message), which forwards the command
    or raises to reject it; hold() keeps the actuator at its measured posture. A
    rejection is logged and never stops the node's executor.
    """
    from rosidl_runtime_py.utilities import get_message
    from std_srvs.srv import Trigger

    def submit(name, apply, message):
        try:
            apply(message)
        except Exception as error:
            node.get_logger().warning(f"{name} rejected: {error}")

    def stop(request, response):
        try:
            hold()
            response.success = True
        except Exception as error:
            response.message = f"{type(error).__name__}: {error}"
        return response

    for name, apply in commands.items():
        operation = operations[name]
        node.create_subscription(get_message(operation["type"]), operation["endpoint"],
                                 lambda message, name=name, apply=apply: submit(name, apply, message), qos(operation))
    # Senders discover stop before commanding, so it must follow the subscriptions.
    node.create_service(Trigger, operations["stop"]["endpoint"], stop)


def json_service(node, operation, handler):
    """Serve handler(**request) -> dict on an owned node's Json operation."""
    from kinex_interfaces.srv import Json

    def call(request, response):
        # Handler failures are responses; they must not stop the node's executor.
        try:
            response.response = json.dumps(handler(**json.loads(request.request)), allow_nan=False)
            response.success = True
        except Exception as error:
            response.message = f"{type(error).__name__}: {error}"
        return response
    return node.create_service(Json, operation["endpoint"], call)


class LinkPublisher(Node):
    """Publish every URDF link below the device base from measured joints, mimics included."""

    def __init__(self, profile, context, directory):
        super().__init__(node_name(profile, "links"), context=context)
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

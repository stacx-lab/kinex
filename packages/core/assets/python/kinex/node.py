"""Building blocks for device nodes: names, placement, managed motion, JSON services and URDF link frames."""
import asyncio
import json
import re
from collections import OrderedDict
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


class Ownership:
    """Generations per owner; a newer owner replaces older ones and stop invalidates all."""

    def __init__(self):
        self.counter = 0
        self.active = None
        self.issued = OrderedDict()
        self.floor = 0

    def acquire(self, owner):
        if not owner:
            raise ValueError("owner must be nonempty")
        if owner not in self.issued:
            self.counter += 1
            self.issued[owner] = self.counter
            if len(self.issued) > 256:
                self.issued.popitem(last=False)
        return self.issued[owner]

    def validate(self, owner, generation):
        if self.issued.get(owner) != generation or generation <= self.floor:
            raise ValueError("command ownership was invalidated; start a new invocation")
        if self.active and generation < self.active[1]:
            raise ValueError("command was replaced by a newer owner")

    def accept(self, owner, generation):
        self.active = (owner, generation)

    def stop(self, owner=""):
        """Owner-scoped stop cannot stop a newer owner; an empty owner always stops."""
        if owner:
            self.issued.pop(owner, None)
            if not self.active or self.active[0] != owner:
                return False
        self.invalidate()
        return True

    def invalidate(self):
        self.floor = self.counter
        self.issued.clear()
        self.active = None


def motion_service(node, operations, commands, hold):
    """Serve managed input topics under one ownership: commands maps each operation name
    to apply(message), which admits its command or raises to reject it, and hold() keeps
    the actuator at its measured posture after an accepted stop. The operations share
    their acquire, stop and status endpoints."""
    from kinex_interfaces.msg import CommandStatus
    from kinex_interfaces.srv import Acquire, Stop
    from rclpy.qos import DurabilityPolicy, QoSProfile
    from rosidl_runtime_py.utilities import get_message

    ownership = Ownership()
    endpoints = {json.dumps(operations[name]["motion"], sort_keys=True) for name in commands}
    if len(endpoints) != 1:
        raise ValueError("managed operations served together must share their motion endpoints")
    motion = operations[next(iter(commands))]["motion"]
    status = node.create_publisher(CommandStatus, motion["status"],
                                   QoSProfile(depth=64, durability=DurabilityPolicy.TRANSIENT_LOCAL))

    def acquire(request, response):
        try:
            response.generation, response.success = ownership.acquire(request.owner), True
        except ValueError as error:
            response.message = str(error)
        return response

    def submit(message, apply):
        result = CommandStatus(owner=message.owner, generation=message.generation, command_id=message.command_id)
        # Rejections are statuses; they must not stop the node's executor.
        try:
            if not message.command_id:
                raise ValueError("command_id must be nonempty")
            ownership.validate(message.owner, message.generation)
            apply(message)
            ownership.accept(message.owner, message.generation)
            result.accepted, result.message = True, "reference accepted; verify measured feedback"
        except Exception as error:
            result.message = str(error)
        status.publish(result)

    def stop(request, response):
        response.stopped = ownership.stop(request.owner)
        if response.stopped:
            hold()
        response.success = True
        response.message = "hold applied" if response.stopped else "owner already replaced"
        return response

    for name, apply in commands.items():
        operation = operations[name]
        node.create_subscription(get_message(operation["type"]), operation["endpoint"],
                                 lambda message, apply=apply: submit(message, apply), qos(operation))
    node.create_service(Acquire, motion["acquire"], acquire)
    node.create_service(Stop, motion["stop"], stop)


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

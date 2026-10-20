"""Persistent model-based FK/IK and measured joint frames, independent of drivers."""
import asyncio
from pathlib import Path

from geometry_msgs.msg import Pose
from kinex_interfaces.srv import ForwardKinematics, InverseKinematics
from rclpy.node import Node
from sensor_msgs.msg import JointState
from tf2_ros import TransformBroadcaster

from kinex.communication import qos
from kinex.joints import JointDevice
from kinex.ros_frames import dynamic_qos, frame_id, transform


def pose_values(value):
    p, q = value.position, value.orientation
    return [p.x, p.y, p.z, q.x, q.y, q.z, q.w]


def pose_message(values):
    result = Pose()
    result.position.x, result.position.y, result.position.z = values[:3]
    result.orientation.x, result.orientation.y, result.orientation.z, result.orientation.w = values[3:]
    return result


class KinematicsNode(Node):
    def __init__(self, profile, context, directory=None):
        super().__init__(profile["name"] + "_kinematics", context=context)
        self.model = JointDevice(profile, directory or Path.cwd())
        if self.model.solver is None or self.model.kinematics["fk"] != "numerical":
            raise ValueError("kinematics node requires URDF or serial-chain geometry and numerical FK")
        self.base = profile["name"]
        self.frame = self.model.kinematics["frame"]
        self.names = [joint["name"] for joint in self.model.joints]
        self.observed = False
        self.error = None
        self.broadcaster = TransformBroadcaster(self, qos=dynamic_qos())
        operations = profile["operations"]
        state = operations["joint_state"]
        self.create_subscription(JointState, state["endpoint"], self.state, qos(state))
        self.create_service(ForwardKinematics, operations["fk"]["endpoint"], self.fk)
        if "ik" in operations:
            if not self.model.options or self.model.options["backend"] != "numerical":
                raise ValueError("IK operation requires a numerical IK model")
            self.create_service(InverseKinematics, operations["ik"]["endpoint"], self.ik)

    def state(self, message):
        try:
            if len(message.name) != len(set(message.name)):
                raise ValueError("joint feedback contains duplicate names")
            values = dict(zip(message.name, message.position, strict=True))
            joints = [values[name] for name in self.names]
            # Measured positions are never clamped to commanded joint limits.
            pose = self.model.fk(joints)["pose"]
            self.broadcaster.sendTransform(transform(
                self.base, frame_id(self.base, self.frame), pose, message.header.stamp))
            self.observed, self.error = True, None
        except (ValueError, KeyError) as error:
            self.error = str(error)
            self.get_logger().error(f"Invalid joint feedback: {error}")

    async def ready(self):
        while not self.observed:
            if self.error:
                raise ValueError(self.error)
            await asyncio.sleep(.02)
        if self.error:
            raise ValueError(self.error)

    def fk(self, request, response):
        try:
            result = self.model.fk(list(request.joints), request.frame or None, request.reference_frame or None)
            response.pose = pose_message(result["pose"])
            response.frame = result["frame"]
            response.reference_frame = result["reference_frame"] or ""
            response.success = True
        except (ValueError, RuntimeError) as error:
            response.message = str(error)
        return response

    def ik(self, request, response):
        try:
            result = self.model.ik(pose_values(request.target), list(request.seed),
                                   request.frame or None, request.reference_frame or None)
            response.joints, response.success = result["joints"], True
        except (ValueError, RuntimeError) as error:
            response.message = str(error)
        return response

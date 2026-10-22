"""Reference joint node adapting a ros2_control JointTrajectoryController to the Kinex joint contract.

Set STATE to the driver's JointState topic and TRAJECTORY to the controller's
joint_trajectory topic, both in URDF joint units. This node republishes measured
joints, forwards owned trajectories, rejects points outside the URDF limits when
the profile's limits are strict, and holds the measured posture on stop.
"""
import asyncio
from pathlib import Path

from builtin_interfaces.msg import Duration
from rclpy.node import Node
from sensor_msgs.msg import JointState
from trajectory_msgs.msg import JointTrajectory, JointTrajectoryPoint

from kinex.communication import qos
from kinex.joints import JointModel, home_start_tolerance, recovery_targets
from kinex.ownership import motion_service

STATE = "/joint_states"
TRAJECTORY = "/joint_trajectory_controller/joint_trajectory"
HOLD_S = .1


class Joints(Node):
    def __init__(self, profile, context):
        super().__init__("kinex_" + profile["name"], context=context)
        self.profile = profile
        self.joints = {joint["name"]: joint for joint in JointModel(profile, Path(__file__).parent).joints}
        self.names = list(self.joints)
        self.position = None
        operations = profile["operations"]
        state = operations["joint_state"]
        self.state = self.create_publisher(JointState, state["endpoint"], qos(state))
        self.create_subscription(JointState, STATE, self.receive, qos(state))
        self.trajectory = self.create_publisher(JointTrajectory, TRAJECTORY, 10)
        motion_service(self, operations["joint_target"], self.apply, self.hold)

    def receive(self, message):
        values = dict(zip(message.name, message.position))
        if all(name in values for name in self.names):
            self.position = [values[name] for name in self.names]
        self.state.publish(message)

    def apply(self, message):
        trajectory = message.trajectory
        if not trajectory.points or not set(trajectory.joint_names) <= set(self.names):
            raise ValueError("trajectory requires points over commanded joints")
        if self.profile["limits"] == "strict":
            joints = [self.joints[name] for name in trajectory.joint_names]
            targets = [list(point.positions) for point in trajectory.points]
            recovery_targets(targets, joints, home_start_tolerance(self.profile, joints, targets[-1]))
        self.trajectory.publish(trajectory)

    def hold(self):
        # Replace the active trajectory with the measured posture; a stop never moves elsewhere.
        if self.position is not None:
            point = JointTrajectoryPoint(positions=self.position, time_from_start=Duration(nanosec=int(HOLD_S * 1e9)))
            self.trajectory.publish(JointTrajectory(joint_names=self.names, points=[point]))

    async def ready(self):
        while self.position is None:
            await asyncio.sleep(.02)


def create(profile, context):
    return Joints(profile, context)

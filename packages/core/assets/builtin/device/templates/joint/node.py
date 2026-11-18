"""Reference joint node adapting a ros2_control stack to the Kinex joint contract.

Set STATE to the driver's JointState topic in URDF joint units. For joint targets
set TRAJECTORY to a JointTrajectoryController's joint_trajectory topic. For pose
targets set TARGETS to the topic on which a pose-tracking controller, such as
FZI's cartesian_motion_controller or MoveIt Servo, takes each tip link's
geometry_msgs/PoseStamped target in the URDF base link, and STATES to the topics
where it reports them, if any. The node serves the commands the profile declares:
it rejects joint points outside strict URDF limits, streams pose trajectories by
interpolating them at RATE_HZ, lets the latest command of either kind replace the
active one and holds the measured posture on stop. Switch the vendor's active
controller in use() when joint and pose targets need different ones.
"""
import asyncio
from pathlib import Path

from builtin_interfaces.msg import Duration
from geometry_msgs.msg import Point, Pose, PoseStamped, Quaternion, Transform, Vector3
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import JointState, MultiDOFJointState
from trajectory_msgs.msg import JointTrajectory, JointTrajectoryPoint

from kinex.communication import qos
from kinex.common.joints import JointModel, command, pose_at, pose_command
from kinex.node import command_service, node_name

STATE = "/joint_states"
TRAJECTORY = "/joint_trajectory_controller/joint_trajectory"
TARGETS = {"flange": "/cartesian_motion_controller/target_frame"}
STATES = {}
# Tips whose orientation the controller does not track; their rotation is ignored.
POSITION_ONLY = ()
RATE_HZ = 100
HOLD_S = .1


class Joints(Node):
    def __init__(self, profile, context):
        super().__init__(node_name(profile), context=context)
        self.profile = profile
        self.model = JointModel(profile, Path(__file__).parent)
        self.joints = {joint["name"]: joint for joint in self.model.joints}
        self.position = self.plan = None
        operations = profile["operations"]
        state = operations["joint_state"]
        self.state = self.create_publisher(JointState, state["endpoint"], qos(state))
        self.create_subscription(JointState, STATE, self.receive, qos_profile_sensor_data)
        commands = {}
        if "joint_target" in operations:
            self.trajectory = self.create_publisher(JointTrajectory, TRAJECTORY, 10)
            commands["joint_target"] = self.apply
        if "pose_target" in operations:
            if not set(TARGETS) <= set(self.model.tips):
                raise ValueError("TARGETS must map tip links of the profile")
            self.targets = {tip: self.create_publisher(PoseStamped, topic, 10) for tip, topic in TARGETS.items()}
            self.create_timer(1 / RATE_HZ, self.stream)
            commands["pose_target"] = self.aim
        if "pose_state" in operations:
            self.reported = {}
            self.pose_state = self.create_publisher(MultiDOFJointState, operations["pose_state"]["endpoint"],
                                                    qos(operations["pose_state"]))
            for tip, topic in STATES.items():
                self.create_subscription(PoseStamped, topic, lambda message, tip=tip: self.report(tip, message),
                                         qos_profile_sensor_data)
        self.kind = "joint" if "joint_target" in commands else "pose"
        command_service(self, operations, commands, self.hold)

    def receive(self, message):
        values = dict(zip(message.name, message.position))
        if all(name in values for name in self.model.names):
            self.position = [values[name] for name in self.model.names]
        self.state.publish(message)

    def use(self, kind):
        # Activate the vendor controller for this kind here when the two differ.
        self.kind = kind

    def apply(self, trajectory):
        if not set(trajectory.joint_names) <= set(self.joints):
            raise ValueError("trajectory names joints this device does not command")
        command(self.profile, [list(point.positions) for point in trajectory.points],
                [self.joints[name] for name in trajectory.joint_names])
        self.use("joint")
        self.plan = None
        self.trajectory.publish(trajectory)

    def aim(self, trajectory):
        plan = pose_command(self.profile, trajectory, POSITION_ONLY)
        if not set(plan[0][1]) <= set(TARGETS):
            raise ValueError("pose targets name tips this node does not forward")
        start = {tip: self.current(tip) for tip in plan[0][1]}
        self.use("pose")
        self.plan = (self.now(), start, plan)

    def current(self, tip):
        # Continue from the streamed target, or start from the measured tip.
        if self.plan and tip in self.plan[1]:
            return pose_at(self.plan[1], self.plan[2], self.now() - self.plan[0])[tip]
        if self.position is None:
            raise ValueError("no measured joint state yet")
        return self.model.fk(self.position, tip)

    def stream(self):
        if not self.plan:
            return
        stamp, frame = self.get_clock().now().to_msg(), self.profile["model"]["base_link"]
        for tip, value in pose_at(self.plan[1], self.plan[2], self.now() - self.plan[0]).items():
            target = PoseStamped(pose=Pose(position=Point(x=value[0], y=value[1], z=value[2]),
                                           orientation=Quaternion(x=value[3], y=value[4], z=value[5], w=value[6])))
            target.header.stamp, target.header.frame_id = stamp, frame
            self.targets[tip].publish(target)

    def report(self, tip, message):
        self.reported[tip] = message.pose
        if len(self.reported) < len(STATES):
            return
        tips = list(STATES)
        state = MultiDOFJointState(joint_names=tips, transforms=[transform(self.reported[tip]) for tip in tips])
        state.header.stamp, state.header.frame_id = message.header.stamp, f"{self.profile['name']}/base"
        self.pose_state.publish(state)

    def hold(self):
        # Replace the active command with the measured posture; a stop never moves elsewhere.
        if self.position is None:
            return
        if self.kind == "pose":
            self.plan = (self.now(), {tip: self.model.fk(self.position, tip) for tip in TARGETS}, [])
            return
        point = JointTrajectoryPoint(positions=self.position, time_from_start=Duration(nanosec=int(HOLD_S * 1e9)))
        self.trajectory.publish(JointTrajectory(joint_names=self.model.names, points=[point]))

    def now(self):
        return self.get_clock().now().nanoseconds * 1e-9

    async def ready(self):
        while self.position is None:
            await asyncio.sleep(.02)


def transform(pose):
    return Transform(translation=Vector3(x=pose.position.x, y=pose.position.y, z=pose.position.z),
                     rotation=pose.orientation)


def create(profile, context):
    return Joints(profile, context)

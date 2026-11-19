"""Reference node construction checks with ROS client modules stubbed."""
import asyncio
import importlib.util
import math
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace as NS
import unittest
from unittest.mock import patch

TEMPLATES = Path(__file__).parent.parent / "assets/builtin/device/templates"


class Node:
    executor = None

    def __init__(self, name, **_):
        self.name, self.services, self.nanoseconds = name, {}, 0
        self.published, self.subscriptions, self.warnings = {}, {}, []

    def create_publisher(self, kind, topic, *_):
        return NS(publish=self.published.setdefault(topic, []).append)

    def create_subscription(self, kind, topic, callback, *_):
        self.subscriptions[topic] = callback

    def get_logger(self):
        return NS(warning=self.warnings.append)

    def create_service(self, kind, endpoint, callback, **_):
        self.services[endpoint] = callback

    def create_timer(self, *_, **__):
        pass

    def get_clock(self):
        return NS(now=lambda: NS(nanoseconds=self.nanoseconds, to_msg=lambda: None))


def modules():
    stubs = {name: ModuleType(name) for name in (
        "rclpy", "rclpy.node", "rclpy.qos", "sensor_msgs", "sensor_msgs.msg", "geometry_msgs",
        "geometry_msgs.msg", "std_srvs", "std_srvs.srv", "tf2_ros")}
    stubs["rclpy.node"].Node = Node
    stubs["rclpy.qos"].qos_profile_sensor_data = None
    for module, names in (("sensor_msgs.msg", ("Imu", "MagneticField", "JointState")),
                          ("geometry_msgs.msg", ("WrenchStamped",)), ("std_srvs.srv", ("Trigger",)),
                          ("tf2_ros", ("StaticTransformBroadcaster", "TransformBroadcaster"))):
        for name in names:
            setattr(stubs[module], name, type(name, (), {}))
    return stubs


def joint_modules():
    """Message stubs for the joint reference node; stamped messages carry a header."""
    def stamped(name):
        def init(self, **fields):
            self.header = NS(stamp=None, frame_id="")
            vars(self).update(fields)
        return type(name, (), {"__init__": init})
    stubs = {name: ModuleType(name) for name in (
        "builtin_interfaces", "builtin_interfaces.msg", "trajectory_msgs", "trajectory_msgs.msg",
        "rosidl_runtime_py", "rosidl_runtime_py.utilities")}
    stubs["builtin_interfaces.msg"].Duration = NS
    stubs["trajectory_msgs.msg"].__dict__.update(JointTrajectory=NS, JointTrajectoryPoint=NS)
    stubs["rosidl_runtime_py.utilities"].get_message = lambda _: object
    sys.modules["geometry_msgs.msg"].__dict__.update(Point=NS, Pose=NS, Quaternion=NS, Transform=NS, Vector3=NS,
                                                     PoseStamped=stamped("PoseStamped"))
    sys.modules["sensor_msgs.msg"].MultiDOFJointState = stamped("MultiDOFJointState")
    sys.modules["rclpy.qos"].__dict__.update(QoSProfile=NS, ReliabilityPolicy=NS(RELIABLE=0, BEST_EFFORT=1),
                                              DurabilityPolicy=NS(VOLATILE=0, TRANSIENT_LOCAL=1))
    return stubs


def node(template):
    spec = importlib.util.spec_from_file_location(template, TEMPLATES / template / "node.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ReferenceNodes(unittest.TestCase):
    def setUp(self):
        patcher = patch.dict(sys.modules, modules())
        patcher.start()
        self.addCleanup(patcher.stop)
        sys.modules.pop("kinex.node", None)

    def test_node_names_are_legal_ros_names(self):
        from kinex.node import node_name
        self.assertEqual(node_name({"name": "wrist-cam.2 left"}), "kinex_wrist_cam_2_left")
        self.assertEqual(node_name({"name": "3d"}, "links"), "kinex_3d_links")

    def test_world_waits_are_sequential_and_stop_cancels_them(self):
        asyncio.run(self.world())

    async def world(self):
        loop = asyncio.get_running_loop()
        stubs = {name: ModuleType(name) for name in (
            "rclpy.callback_groups", "rclpy.task", "rosgraph_msgs", "rosgraph_msgs.msg", "custom_interfaces", "custom_interfaces.srv")}
        stubs["rclpy.callback_groups"].ReentrantCallbackGroup = object
        stubs["rclpy.task"].Future = lambda executor=None: loop.create_future()
        stubs["rosgraph_msgs.msg"].Clock = NS
        stubs["custom_interfaces.srv"].Wait = object
        sys.modules["rclpy.qos"].__dict__.update(QoSProfile=NS, ReliabilityPolicy=NS(RELIABLE=0, BEST_EFFORT=1),
                                                  DurabilityPolicy=NS(VOLATILE=0, TRANSIENT_LOCAL=1))
        with patch.dict(sys.modules, stubs):
            world = node("world").WallClock({"name": "world", "operations": {
                name: {"endpoint": f"/{name}"} for name in ("time", "wait", "stop")}}, None)
        wait = lambda duration: world.wait(NS(duration_s=duration), NS(success=False, message="", time_s=0., waited_s=0.))
        first = asyncio.ensure_future(wait(1.))
        await asyncio.sleep(0)
        self.assertIn("another wait is pending", (await wait(1.)).message)
        self.assertTrue(world.stop(None, NS(success=False)).success)
        self.assertEqual(((result := await first).success, result.message), (False, "cancelled by stop"))
        second = asyncio.ensure_future(wait(.5))
        await asyncio.sleep(0)
        world.nanoseconds = 500_000_000
        world.tick()
        self.assertEqual(((result := await second).success, result.waited_s), (True, .5))

    def test_joint_node_streams_pose_targets_until_a_joint_target_or_stop_replaces_them(self):
        from kinex.common.urdf import read_tree
        sys.modules.update(joint_modules())
        tree = read_tree(None, "base_link", """<robot name="arm"><link name="base_link"/><link name="link"/>
  <link name="flange"/><joint name="j" type="revolute"><parent link="base_link"/><child link="link"/>
    <axis xyz="0 0 1"/><limit lower="-2" upper="2"/></joint>
  <joint name="flange_joint" type="fixed"><parent link="link"/><child link="flange"/><origin xyz="1 0 0"/></joint></robot>""")
        operations = {name: {"endpoint": f"/{name}", "type": "pkg/msg/Type"}
                      for name in ("joint_state", "joint_target", "pose_target", "stop")}
        joints = node("joint")
        arm = joints.Joints({"name": "arm", "type": "joint", "limits": "strict", "home": None, "operations": operations,
                             "model": {"base_link": "base_link", "tip_links": ["flange"]}, "resolved_model": tree}, None)
        targets, trajectories = (arm.published.setdefault(topic, []) for topic in (joints.TARGETS["flange"], joints.TRAJECTORY))
        arm.subscriptions[joints.STATE](NS(name=["j"], position=[0.]))
        half = math.sqrt(.5)
        target = lambda frame="arm/base", tip="flange": NS(header=NS(frame_id=frame), joint_names=[tip], points=[NS(
            time_from_start=NS(sec=2, nanosec=0), transforms=[NS(translation=NS(x=0., y=1., z=0.),
                                                                 rotation=NS(x=0., y=0., z=half, w=half))])])
        arm.subscriptions["/pose_target"](target("arm/flange"))
        arm.subscriptions["/pose_target"](target(tip="link"))
        self.assertEqual(len(arm.warnings), 2)
        arm.subscriptions["/pose_target"](target())
        arm.nanoseconds = 1_000_000_000
        arm.stream()
        streamed = targets[-1]
        self.assertEqual(streamed.header.frame_id, "base_link")
        self.assertEqual([round(v, 9) for v in (streamed.pose.position.x, streamed.pose.position.y,
                                                streamed.pose.orientation.z, streamed.pose.orientation.w)],
                         [.5, .5, round(math.sin(math.pi / 8), 9), round(math.cos(math.pi / 8), 9)])
        arm.subscriptions["/joint_target"](NS(joint_names=["j"], points=[NS(positions=[.5])]))
        self.assertEqual(len(trajectories), 1)
        arm.stream()
        self.assertEqual(len(targets), 1)
        arm.subscriptions["/pose_target"](target())
        self.assertTrue(arm.services["/stop"](None, NS(success=False, message="")).success)
        arm.stream()
        held = targets[-1].pose
        self.assertEqual((held.position.x, held.position.y, held.orientation.w), (1., 0., 1.))
        self.assertEqual(len(trajectories), 1)

    def test_unrecorded_inertial_facts_fail_with_guidance(self):
        imu = node("imu")
        channel = {"bias": {"x": 0., "y": 0., "z": 0.}}
        for measurement, message in (("???", "measured channels"),
                                     ({"angular_velocity": "???"}, "angular_velocity channel"),
                                     ({"angular_velocity": None, "linear_acceleration": channel, "magnetic_field": None,
                                       "orientation": "???"}, "orientation channel")):
            with self.assertRaisesRegex(ValueError, message):
                imu.InertialSensor({"name": "imu", "measurement": measurement}, None)

    def test_unrecorded_wrench_facts_fail_with_guidance(self):
        force_torque = node("force_torque")
        for measurement, message in (("???", "measured channels"), ({"force": "???", "torque": None}, "force channel"),
                                     ({"force": {"bias": "???"}, "torque": None}, "force bias")):
            with self.assertRaisesRegex(ValueError, message):
                force_torque.ForceTorque({"name": "ft", "measurement": measurement}, None)

    def test_the_host_publishes_urdf_links_only_for_joint_and_gripper_models(self):
        sent = {"static": [], "moving": []}
        sys.modules.update(joint_modules())
        sys.modules["geometry_msgs.msg"].TransformStamped = lambda: NS(
            header=NS(frame_id="", stamp=None), child_frame_id="", transform=NS(translation=NS(), rotation=NS()))
        sys.modules["tf2_ros"].StaticTransformBroadcaster = lambda node: NS(sendTransform=sent["static"].extend)
        sys.modules["tf2_ros"].TransformBroadcaster = lambda node, qos: NS(sendTransform=sent["moving"].extend)
        sys.modules.pop("kinex.host.links", None)
        from kinex.host.device import has_links
        from kinex.host.links import LinkPublisher
        state = {"joint_state": {"endpoint": "/gripper/joint_state", "type": "sensor_msgs/msg/JointState"}}
        model = {"format": "urdf", "path": "gripper.urdf", "base_link": "base_link"}
        gripper = {"name": "gripper", "type": "gripper", "operations": state, "model": model}
        directory = TEMPLATES / "gripper"
        # Only joint and gripper profiles hold a URDF model; nothing else starts a publisher.
        for profile in ({**gripper, "type": "rgb"}, {"name": "sam", "type": "model", "operations": {}, "family": "sam"}, {"name": "bare", "operations": state},
                        {**gripper, "model": {**model, "path": "???"}}, {**gripper, "model": "???"},
                        {**gripper, "model": {**model, "format": "mjcf"}}, {**gripper, "operations": {}}):
            self.assertFalse(has_links(profile))
        self.assertTrue(has_links(gripper))
        self.assertTrue(has_links({**gripper, "type": "joint", "model": {**model, "tip_links": []}}))
        links = LinkPublisher(gripper, None, directory)
        self.assertEqual(links.name, "kinex_gripper_links")
        self.assertEqual([(t.header.frame_id, t.child_frame_id) for t in sent["static"]],
                         [("gripper/left_finger", "gripper/left_pad"), ("gripper/right_finger", "gripper/right_pad")])
        links.subscriptions["/gripper/joint_state"](NS(name=["finger_joint"], position=[.01], header=NS(stamp="measured")))
        # The base link is the device base; the mimic finger follows the measured one.
        self.assertEqual([(t.header.frame_id, t.child_frame_id, t.header.stamp, round(t.transform.translation.y, 6))
                          for t in sent["moving"]],
                         [("gripper/base", "gripper/left_finger", "measured", .01),
                          ("gripper/base", "gripper/right_finger", "measured", -.01)])
        self.assertTrue(links.observed)


if __name__ == "__main__":
    unittest.main()

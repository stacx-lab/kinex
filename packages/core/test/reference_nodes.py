"""Reference node construction checks with ROS client modules stubbed."""
import asyncio
import importlib.util
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

    def create_publisher(self, *_):
        return NS(publish=lambda _: None)

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
            "rclpy.callback_groups", "rclpy.task", "rosgraph_msgs", "rosgraph_msgs.msg", "kinex_interfaces", "kinex_interfaces.srv")}
        stubs["rclpy.callback_groups"].ReentrantCallbackGroup = object
        stubs["rclpy.task"].Future = lambda executor=None: loop.create_future()
        stubs["rosgraph_msgs.msg"].Clock = NS
        stubs["kinex_interfaces.srv"].Wait = object
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


if __name__ == "__main__":
    unittest.main()

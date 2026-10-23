"""Reference node construction checks with ROS client modules stubbed."""
import importlib.util
from pathlib import Path
import sys
from types import ModuleType
import unittest
from unittest.mock import patch

TEMPLATES = Path(__file__).parent.parent / "assets/builtin/device/templates"


class Node:
    def __init__(self, name, **_):
        self.name = name


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

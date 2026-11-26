"""Devices and operations describe themselves; interfaces come from installed definitions without ROS."""
import importlib.util
import json
import subprocess
import sys
import unittest
from unittest.mock import patch

from kinex.communication import Scope
from kinex.device import Device

ROS = importlib.util.find_spec("rosidl_runtime_py") is not None
CATALOG = {"arm.joint_state": {"description": "Measured joints.", "transport": "topic", "direction": "output",
                               "type": "sensor_msgs/msg/JointState", "endpoint": "/arm/joint_state"},
           "arm.move": {"description": "Move the tool.", "transport": "action", "direction": "input",
                        "type": "custom_interfaces/action/Json", "endpoint": "/arm/move"}}
FOUND = {"interface": {"message": {"position": "sequence<double>"}}, "types": {}}


class Describe(unittest.TestCase):
    def test_an_operation_gives_its_declaration_and_interface_and_a_device_its_profile_once(self):
        arm = Device(Scope(catalog=CATALOG), "arm")
        with patch("kinex.common.interfaces.interface", return_value=FOUND) as interface:
            self.assertEqual(arm.topic("joint_state").describe(), {"description": "Measured joints.", "transport": "topic",
                             "direction": "output", "type": "sensor_msgs/msg/JointState", **FOUND})
            self.assertEqual(arm.action("move").describe()["description"], "Move the tool.")
        self.assertEqual([call.args for call in interface.call_args_list],
                         [("sensor_msgs/msg/JointState",), ("custom_interfaces/action/Json",)])
        profile = {"description": "A six-joint arm.", "operations": {name.split(".")[1]: spec for name, spec in CATALOG.items()}}
        with patch("kinex._rpc", return_value={"profile": profile}) as rpc, \
                patch("kinex.common.interfaces.interface", return_value=FOUND):
            described = arm.describe()
            self.assertIs(arm.profile, profile)
        rpc.assert_called_once_with({"call": "profile", "device": "arm"})
        self.assertEqual((described["description"], list(described["operations"])), ("A six-joint arm.", ["joint_state", "move"]))

    def test_a_missing_interface_says_why_in_place_of_failing(self):
        arm = Device(Scope(catalog=CATALOG), "arm")
        with patch("kinex.common.interfaces.interface", side_effect=ModuleNotFoundError("No module named 'sensor_msgs'")):
            described = arm.topic("joint_state").describe()
        self.assertEqual((described["type"], described["error"]), ("sensor_msgs/msg/JointState",
                         "Kinex Python lacks interface sensor_msgs/msg/JointState: No module named 'sensor_msgs'"))
        self.assertNotIn("interface", described)

    @unittest.skipUnless(ROS, "needs ROS interface definitions")
    def test_interfaces_name_their_parts_and_nest_each_message_once(self):
        from kinex.common.interfaces import interface
        state = interface("sensor_msgs/msg/JointState")
        self.assertEqual(state["interface"]["message"]["header"], "std_msgs/Header")
        self.assertEqual(state["types"], {"std_msgs/Header": {"stamp": "builtin_interfaces/Time", "frame_id": "string"},
                                          "builtin_interfaces/Time": {"sec": "int32", "nanosec": "uint32"}})
        self.assertEqual(interface("std_srvs/srv/Trigger")["interface"], {"request": {}, "response": {"success": "boolean", "message": "string"}})
        self.assertEqual(set(interface("control_msgs/action/GripperCommand")["interface"]), {"goal", "result", "feedback"})

    @unittest.skipUnless(ROS, "needs ROS interface definitions")
    def test_the_module_answers_each_type_or_why_it_has_none(self):
        run = subprocess.run([sys.executable, "-m", "kinex.common.interfaces"], input=json.dumps(["std_srvs/srv/Trigger", "nothing_msgs/msg/None"]),
                             capture_output=True, text=True, check=True)
        found = json.loads(run.stdout)
        self.assertEqual(found["std_srvs/srv/Trigger"]["interface"]["response"], {"success": "boolean", "message": "string"})
        self.assertIn("nothing_msgs", found["nothing_msgs/msg/None"]["error"])


if __name__ == "__main__":
    unittest.main()

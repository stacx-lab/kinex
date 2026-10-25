"""Bundled tools use protocol operations; numerical payloads stay in Python."""
import asyncio
import importlib.util
from pathlib import Path
import sys
from types import SimpleNamespace as NS, ModuleType
import unittest
from unittest.mock import AsyncMock, Mock, patch

from kinex import helpers
from kinex.errors import RPCError

ROOT = Path(__file__).parent.parent / "assets/builtin/tool"


def tool(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / name / "tool.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Stream:
    def __init__(self):
        self.closed = False

    async def next(self, **_):
        return NS(name=["j1", "j0"], position=[.1, 0.], header=NS(stamp=0))

    def close(self):
        self.closed = True


class Protocol:
    def __init__(self):
        self.catalog = {"world.wait": {}}
        self.events = []
        self.streams = []

    def subscribe(self, operation, **_):
        self.events.append(("subscribe", operation))
        stream = Stream()
        self.streams.append(stream)
        return stream

    async def request(self, operation, **fields):
        self.events.append(("request", operation, fields))
        if operation == "model.infer":
            return {"actions": [[.2, .3], [.4, .5]]}
        return NS(success=True)

    async def publish(self, operation, fields):
        self.events.append(("publish", operation, fields))


def profile(_):
    from kinex.lib.urdf import read_tree
    return {
        "name": "arm", "type": "joint", "loaded": True, "runtime": {}, "home": None, "limits": "strict",
        "model": {"format": "urdf", "path": "arm.urdf", "base_link": "base_link", "tip_link": "flange"},
        "resolved_model": read_tree(None, "base_link", """<robot name="arm">
  <link name="base_link"/><link name="upper"/><link name="lower"/><link name="flange"/>
  <joint name="j0" type="revolute"><parent link="base_link"/><child link="upper"/><axis xyz="0 0 1"/>
    <limit lower="-1" upper="1" velocity="1"/></joint>
  <joint name="j1" type="revolute"><parent link="upper"/><child link="lower"/><origin xyz=".5 0 0"/>
    <axis xyz="0 1 0"/><limit lower="-1" upper="1" velocity="1"/></joint>
  <joint name="flange_joint" type="fixed"><parent link="lower"/><child link="flange"/><origin xyz=".5 0 0"/></joint>
</robot>"""),
    }


class Tools(unittest.IsolatedAsyncioTestCase):
    def test_helper_index_lists_every_helper(self):
        index = (Path(helpers.__file__).parent / "helpers.txt").read_text()
        for name in helpers.__all__:
            self.assertTrue(callable(getattr(helpers, name)), name)
            self.assertIn(f"helpers.{name}(", index)

    async def test_policy_validates_chunk_before_publishing(self):
        policy, io = tool("run_policy"), Protocol()
        convert = ModuleType("rosidl_runtime_py.convert")
        convert.message_to_ordereddict = lambda value: value
        with patch("kinex.helpers.policy.profile", profile), patch.dict(sys.modules, {
            "rosidl_runtime_py": ModuleType("rosidl_runtime_py"),
            "rosidl_runtime_py.convert": convert,
        }):
            result = await policy.main({"model": "model", "observation": {},
                                        "command": [{"device": "arm"}], "action_hz": 20}, io)
        self.assertEqual(result["actions_submitted"], 2)
        self.assertEqual(result["duration_s"], .1)
        kind, operation, trajectory = io.events[-1]
        self.assertEqual((kind, operation, trajectory["joint_names"]), ("publish", "arm.joint_target", ["j0", "j1"]))
        self.assertEqual(len(trajectory["points"]), 2)

    async def test_scalar_policy_targets_are_persistent_and_paced_by_world(self):
        policy, io = tool("run_policy"), Protocol()
        async def request(operation, **fields):
            io.events.append(("request", operation, fields))
            return {"actions": [[-1.], [1.]]} if operation == "model.infer" else NS(success=True)
        io.request = request
        convert = ModuleType("rosidl_runtime_py.convert")
        convert.message_to_ordereddict = lambda value: value
        facts = {"type": "gripper", "grip": {"joint": "finger_joint", "open": .04, "closed": 0.}}
        with patch("kinex.helpers.policy.profile", return_value=facts), patch.dict(sys.modules, {
            "rosidl_runtime_py": ModuleType("rosidl_runtime_py"), "rosidl_runtime_py.convert": convert,
        }):
            result = await policy.main({"model": "model", "observation": {},
                                       "command": [{"device": "gripper"}], "action_hz": 10}, io)
        self.assertEqual(result["actions_submitted"], 2)
        self.assertEqual([event[2] for event in io.events if event[0] == "publish"],
                         [{"data": .04}, {"data": 0.}])
        self.assertEqual([event[2] for event in io.events if event[:2] == ("request", "world.wait")],
                         [{"duration_s": .1}, {"duration_s": .1}])
        self.assertFalse(any(event[1].endswith(".stop") for event in io.events))

    async def test_end_effector_policy_without_world_wait_never_infers(self):
        policy, io = tool("run_policy"), Protocol()
        io.catalog = {}
        facts = {"type": "gripper", "grip": {"joint": "finger_joint", "open": .04, "closed": 0.}}
        with patch("kinex.helpers.policy.profile", return_value=facts):
            with self.assertRaisesRegex(ValueError, "world wait"):
                await policy.main({"model": "model", "observation": {}, "command": [{"device": "gripper"}]}, io)
        self.assertEqual(io.events, [])

    async def test_relative_pose_uses_tf2_relation_and_local_offsets(self):
        relative = tool("relative_pose")
        async def lookup(io, target, source, stamp):
            self.assertEqual((target, source), ("base", "camera"))
            return NS(transform=NS(translation=NS(x=1., y=0., z=0.),
                                   rotation=NS(x=0., y=0., z=0., w=1.)),
                      header=NS(stamp=NS(sec=2, nanosec=500000000)))
        with patch("kinex.helpers.frames.lookup_transform", lookup):
            result = await relative.main({"parent": {"frame": "base", "pose": [0, 0, .1, 0, 0, 0, 1]},
                                          "child": {"frame": "camera", "pose": [0, 0, .2, 0, 0, 0, 1]}}, Protocol())
        self.assertEqual(result["pose"], [1., 0., .1, 0., 0., 0., 1.])
        self.assertEqual(result["timestamp"], 2.5)

    async def test_policy_cartesian_chunk_uses_scoped_frames_and_typed_ik(self):
        policy = tool("run_policy")

        class Cartesian(Protocol):
            async def request(self, operation, **fields):
                if operation == "model.infer":
                    return {"actions": [[.1, 0., 0., 0., 0., 0., 1.]]}
                return await super().request(operation, **fields)

        io, frames = Cartesian(), []

        async def transform(io, pose, source, target, stamp):
            frames.append((source, target))
            return pose

        convert = ModuleType("rosidl_runtime_py.convert")
        convert.message_to_ordereddict = lambda value: value
        with patch("kinex.helpers.policy.profile", profile), patch("kinex.helpers.frames.transform_pose", transform), patch.dict(sys.modules, {
            "rosidl_runtime_py": ModuleType("rosidl_runtime_py"),
            "rosidl_runtime_py.convert": convert,
        }), patch("kinex.lib.joints.JointModel.ik", autospec=True, return_value=[.2, .3]) as ik:
            result = await policy.main({"model": "model", "observation": {},
                                        "command": [{"device": "arm", "space": "pose"}], "action_hz": 20}, io)
        self.assertEqual(frames, [("arm/flange", "arm/flange"), ("arm/base", "arm/base"), ("arm/base", "arm/base")])
        self.assertEqual(ik.call_args.args[1:], ([.1, 0., 0., 0., 0., 0., 1.], [0., .1]))
        self.assertEqual(result["actions_submitted"], 1)

    async def test_policy_invalid_later_joint_target_never_publishes(self):
        policy, io = tool("run_policy"), Protocol()
        async def request(*args, **kwargs):
            return {"actions": [[0., 0.], [5., 0.]]}
        io.request = request
        convert = ModuleType("rosidl_runtime_py.convert")
        convert.message_to_ordereddict = lambda value: value
        with patch("kinex.helpers.policy.profile", profile), patch.dict(sys.modules, {
            "rosidl_runtime_py": ModuleType("rosidl_runtime_py"), "rosidl_runtime_py.convert": convert,
        }), self.assertRaises(ValueError):
            await policy.main({"model": "model", "observation": {}, "command": [{"device": "arm"}]}, io)
        self.assertFalse(any(event[0] == "publish" for event in io.events))

    async def test_policy_malformed_ik_truncates_all_buffers_and_seeds_from_predecessor(self):
        policy = tool("run_policy")
        for failure_at in (0, 1):
            io, seeds = Protocol(), []
            async def request(operation, **fields):
                return {"actions": [{"arm": [0, 0, 0, 0, 0, 0, 1], "other": [0., 0.]}] * 3}
            def solve(model, goal, seed):
                seeds.append(seed)
                if len(seeds) > failure_at:
                    raise ValueError("IK search exhausted")
                return [.2, .3]
            async def transform(io, pose, *args):
                return pose
            io.request = request
            convert = ModuleType("rosidl_runtime_py.convert")
            convert.message_to_ordereddict = lambda value: value
            with patch("kinex.helpers.policy.profile", profile), patch("kinex.helpers.frames.transform_pose", transform), patch.dict(sys.modules, {
                "rosidl_runtime_py": ModuleType("rosidl_runtime_py"), "rosidl_runtime_py.convert": convert,
            }), patch("kinex.lib.joints.JointModel.ik", autospec=True, side_effect=solve):
                result = await policy.main({"model": "model", "observation": {}, "action_hz": 20,
                    "command": [{"device": "arm", "space": "pose"}, {"device": "other"}]}, io)
            self.assertEqual(result["actions_submitted"], failure_at)
            self.assertEqual(result["duration_s"], failure_at / 20)
            self.assertEqual(seeds, [[0., .1], [.2, .3]][:failure_at + 1])
            self.assertEqual(len([event for event in io.events if event[0] == "publish"]), 2 if failure_at else 0)



class Transforms(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        messages = ModuleType("builtin_interfaces.msg")
        messages.Time = lambda: NS(sec=0, nanosec=0)
        self.enterContext(patch.dict(sys.modules, {"builtin_interfaces.msg": messages}))

    async def test_service_preserves_frames_stamp_and_errors(self):
        relation, stamp = object(), NS(sec=2, nanosec=500000000)
        io = NS(frame_service=object(), _request=AsyncMock(return_value=NS(transform=relation)))
        self.assertIs(await helpers.lookup_transform(io, "arm:base", "camera/optical", stamp, 2), relation)
        io._request.assert_awaited_once_with(io.frame_service, {
            "target_frame": "arm/base", "source_frame": "camera/optical", "stamp": stamp, "wait_s": 2,
        }, 3)
        await helpers.lookup_transform(io, "arm/base", "camera/optical", timeout_s=0)
        self.assertEqual(vars(io._request.call_args.args[1]["stamp"]), {"sec": 0, "nanosec": 0})
        for error in (RPCError("missing frame"), TimeoutError(), asyncio.CancelledError()):
            io._request.side_effect = error
            with self.assertRaises(type(error)) as caught:
                await helpers.lookup_transform(io, "arm/base", "camera/optical")
            self.assertIs(caught.exception, error)

    async def test_missing_service_and_invalid_timeout_do_not_fall_back(self):
        io = NS(frame_service=None, supervised=True, transforms=Mock())
        with self.assertRaises(RPCError) as caught:
            await helpers.lookup_transform(io, "world/base", "arm/tool")
        self.assertEqual(caught.exception.code, "frames_unavailable")
        for timeout in (-1, 31, float("nan"), float("inf")):
            with self.assertRaises(ValueError):
                await helpers.lookup_transform(io, "world/base", "arm/tool", timeout_s=timeout)
        io.transforms.assert_not_called()

    async def test_standalone_uses_communication_owned_history(self):
        time = ModuleType("rclpy.time")
        time.Time = Mock()
        buffer = Mock()
        io = NS(frame_service=None, supervised=False, transforms=Mock(return_value=buffer), _future=AsyncMock())
        stamp = object()
        with patch.dict(sys.modules, {"rclpy.time": time}):
            result = await helpers.lookup_transform(io, "world:base", "arm:tool", stamp)
            self.assertIs(result, buffer.lookup_transform.return_value)
            time.Time.from_msg.assert_called_once_with(stamp)
            buffer.wait_for_transform_async.assert_called_once_with("world/base", "arm/tool", time.Time.from_msg.return_value)
            io._future.assert_awaited_once_with(buffer.wait_for_transform_async.return_value, 5)
            buffer.lookup_transform.assert_called_once_with("world/base", "arm/tool", time.Time.from_msg.return_value)
            io._future.reset_mock()
            await helpers.lookup_transform(io, "world/base", "arm/tool", timeout_s=0)
            io._future.assert_not_awaited()
            buffer.lookup_transform.assert_called_with("world/base", "arm/tool", time.Time.return_value)


def scope(catalog):
    """A Communication with its ROS teardown stubbed."""
    from kinex.communication import Communication
    io = Communication(catalog)
    io.executor = NS(shutdown=lambda **kw: None)
    io.node = NS(destroy_node=lambda: None)
    io.context = NS(try_shutdown=lambda: None)
    io.thread = NS(join=lambda _: None)
    return io


WAIT = {"world.wait": {"transport": "service", "direction": "input", "type": "kinex_interfaces/srv/Wait", "endpoint": "/wait"},
        "world.stop": {"transport": "service", "direction": "input", "type": "std_srvs/srv/Trigger", "endpoint": "/world/stop"}}


class Errors(unittest.IsolatedAsyncioTestCase):
    async def test_service_rejection_retains_response_without_replaying_or_stopping(self):
        from kinex.errors import OperationError
        response = NS(success=False, message="episode ended", time_s=1.5, waited_s=.1)
        convert = ModuleType("rosidl_runtime_py.convert")
        convert.message_to_ordereddict = vars
        with patch.dict(sys.modules, {"rosidl_runtime_py.convert": convert}):
            error = OperationError("world.wait", "kinex_interfaces/srv/Wait", response)
        self.assertIs(error.response, response)
        self.assertEqual(error.payload()["details"]["response"]["time_s"], 1.5)
        io, calls = scope(WAIT), []

        async def rejected(*args, **kwargs):
            calls.append((args, kwargs))
            raise error

        io._request = rejected
        with self.assertRaises(OperationError) as caught:
            await io.request("world.wait", duration_s=.5)
        self.assertIs(caught.exception, error)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][1]["operation"], "world.wait")
        self.assertEqual(io.enrolled, {"world"})

    async def test_abandoned_wait_stops_its_world(self):
        for error in (TimeoutError(), asyncio.CancelledError()):
            io, endpoints = scope(WAIT), []

            async def request(spec, fields, timeout_s=None, **_):
                endpoints.append(spec["endpoint"])
                if spec["endpoint"] == "/wait":
                    raise error
                return NS(success=True)

            io._request = request
            with self.assertRaises(type(error)):
                await io.request("world.wait", duration_s=60)
            self.assertEqual(endpoints, ["/wait", "/world/stop"])

    async def test_scope_failure_stops_commanded_devices_and_success_leaves_them(self):
        for error, stopped in ((None, False), (SystemExit(0), False), (SystemExit(None), False),
                               (SystemExit(1), True), (RuntimeError("failure"), True),
                               (asyncio.CancelledError(), True)):
            io, calls = scope({}), []
            io.enrolled.update({"world", "arm"})

            async def stop(devices):
                calls.append(devices)

            io._stop = stop
            await io.__aexit__(type(error), error, None)
            self.assertEqual(calls, [["arm", "world"]] if stopped else [])

    async def test_unacknowledged_commands_fail_the_scope_and_stop_devices(self):
        rclpy, duration = ModuleType("rclpy"), ModuleType("rclpy.duration")
        duration.Duration = lambda **_: None
        io, calls = scope({}), []
        io.enrolled.add("arm")
        io.publishers = {"arm.joint_target": NS(wait_for_all_acked=lambda timeout: False)}

        async def stop(devices):
            calls.append(devices)

        io._stop = stop
        with patch.dict(sys.modules, {"rclpy": rclpy, "rclpy.duration": duration}), \
                self.assertRaisesRegex(TimeoutError, "arm.joint_target"):
            await io.__aexit__(None, None, None)
        self.assertEqual(calls, [["arm"]])

    async def test_stop_calls_each_declared_stop_service(self):
        io, endpoints = scope({**WAIT, "detector.detect": {"type": "kinex_interfaces/srv/Json", "endpoint": "/detect"}}), []

        async def request(spec, fields, timeout_s=None, **_):
            endpoints.append((spec["endpoint"], fields))
            return NS(success=True)

        io._request = request
        await io._stop(["detector", "world"])
        self.assertEqual(endpoints, [("/world/stop", {})])


class Dialog(unittest.IsolatedAsyncioTestCase):
    async def test_subscription_closes_as_a_context_manager(self):
        import threading
        from collections import deque
        from kinex.communication import Subscription

        def stream():
            io = NS(node=NS(destroy_subscription=Mock()), subscriptions=[])
            value = Subscription.__new__(Subscription)
            value.io, value.handle, value.closed = io, object(), False
            value.lock, value.inbox, value.buffer = threading.Lock(), deque(), deque()
            value.event, value.last = asyncio.Event(), None
            io.subscriptions.append(value)
            return value

        first, second = stream(), stream()
        with first as entered:
            self.assertIs(entered, first)
        async with second as entered:
            self.assertIs(entered, second)
        for value in (first, second):
            self.assertTrue(value.closed)
            value.io.node.destroy_subscription.assert_called_once_with(value.handle)
            self.assertEqual(value.io.subscriptions, [])

    def test_plain_converts_messages_arrays_and_non_finite_numbers(self):
        import numpy as np
        from kinex.lib.plain import plain

        class JointState:
            def get_fields_and_field_types(self):
                return {"name": "sequence<string>", "position": "sequence<double>"}

        class Image:
            def get_fields_and_field_types(self):
                return {"data": "sequence<uint8>"}

        class Frame_Response:
            def get_fields_and_field_types(self):
                return {"image": "sensor_msgs/Image"}

        JointState.__module__ = Image.__module__ = "sensor_msgs.msg._messages"
        Frame_Response.__module__ = "example_interfaces.srv._frame"
        convert = ModuleType("rosidl_runtime_py.convert")
        convert.message_to_ordereddict = lambda _: {"name": ["j1"], "position": np.array([.5, np.nan])}
        with patch.dict(sys.modules, {"rosidl_runtime_py": ModuleType("rosidl_runtime_py"),
                                      "rosidl_runtime_py.convert": convert}):
            self.assertEqual(plain({"state": JointState(), "pair": (np.float32(2), float("inf"))}),
                             {"state": {"name": ["j1"], "position": [.5, None]}, "pair": [2., None]})
            for image in (Image(), Frame_Response()):
                with self.assertRaisesRegex(TypeError, "save_image"):
                    plain({"image": image})


class DeviceHostShutdown(unittest.IsolatedAsyncioTestCase):
    async def test_closed_input_unloads_a_loaded_device(self):
        import io
        from kinex.host import device
        calls = []

        class Host:
            io, tasks = object(), {}

            async def run(self, action, args):
                calls.append((action, args))

        with patch.object(device, "DeviceHost", Host), patch.object(sys, "stdin", io.StringIO("")), \
                patch.object(sys, "stdout", io.StringIO()):
            await device.main()
        self.assertEqual(calls, [("unload", {})])


if __name__ == "__main__":
    unittest.main()

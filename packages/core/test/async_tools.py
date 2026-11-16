"""Lib programs use protocol operations through the ambient scope; numerical payloads stay in Python."""
import asyncio
from pathlib import Path
import sys
from types import SimpleNamespace as NS, ModuleType
import unittest
from unittest.mock import AsyncMock, Mock, patch

from kinex import lib
from kinex.communication import ambient
from kinex.errors import RPCError
from kinex.lib.frames import lookup_transform


class Library(unittest.IsolatedAsyncioTestCase):
    def test_modules_load_on_first_use_and_stay_modules(self):
        self.assertIs(lib.frames.lookup_transform, lookup_transform)
        self.assertTrue(callable(lib.images.camera_geometry))
        for name in ("missing", "_private"):
            with self.assertRaises(AttributeError):
                getattr(lib, name)

    def test_workspace_roots_extend_and_override_builtin_modules(self):
        import subprocess
        import tempfile
        with tempfile.TemporaryDirectory() as near, tempfile.TemporaryDirectory() as far:
            Path(near, "motion.py").write_text("ORIGIN = 'near'\n")
            Path(far, "motion.py").write_text("ORIGIN = 'far'\n")
            Path(far, "tasks", "tabletop").mkdir(parents=True)
            Path(far, "tasks", "tabletop", "pick.py").write_text("from kinex.lib import frames\ndef pick(): return frames.__name__\n")
            code = "from kinex import lib; print(lib.motion.ORIGIN, lib.tasks.tabletop.pick.pick(), lib.kinematics.__name__)"
            output = subprocess.run([sys.executable, "-c", code], env={"PYTHONPATH": str(Path(lib.__file__).parents[2]), "KINEX_LIB": f"{near}:{far}"},
                                    capture_output=True, text=True, check=True).stdout
        self.assertEqual(output.split(), ["near", "kinex.lib.frames", "kinex.lib.kinematics"])

    async def test_ambient_scope_is_required_and_scoped_to_its_block(self):
        from kinex import io
        with self.assertRaisesRegex(RuntimeError, "no communication scope"):
            io.catalog
        with ambient(NS(catalog={"a.b": {}})):
            self.assertEqual(io.catalog, {"a.b": {}})
        with self.assertRaises(RuntimeError):
            io.catalog

    async def test_relative_pose_uses_tf2_relation_and_local_offsets(self):
        async def lookup(target, source, stamp):
            self.assertEqual((target, source), ("base", "camera"))
            return NS(transform=NS(translation=NS(x=1., y=0., z=0.),
                                   rotation=NS(x=0., y=0., z=0., w=1.)),
                      header=NS(stamp=NS(sec=2, nanosec=500000000)))
        with patch("kinex.lib.frames.lookup_transform", lookup):
            result = await lib.frames.relative_pose(parent={"frame": "base", "pose": [0, 0, .1, 0, 0, 0, 1]},
                                                    child={"frame": "camera", "pose": [0, 0, .2, 0, 0, 0, 1]})
        self.assertEqual(result["pose"], [1., 0., .1, 0., 0., 0., 1.])
        self.assertEqual(result["timestamp"], 2.5)


class Transforms(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        messages = ModuleType("builtin_interfaces.msg")
        messages.Time = lambda: NS(sec=0, nanosec=0)
        self.enterContext(patch.dict(sys.modules, {"builtin_interfaces.msg": messages}))

    async def test_service_preserves_frames_stamp_and_errors(self):
        relation, stamp = object(), NS(sec=2, nanosec=500000000)
        io = self.enterContext(ambient(NS(frame_service=object(), _request=AsyncMock(return_value=NS(transform=relation)))))
        self.assertIs(await lookup_transform("arm:base", "camera/optical", stamp, 2), relation)
        io._request.assert_awaited_once_with(io.frame_service, {
            "target_frame": "arm/base", "source_frame": "camera/optical", "stamp": stamp, "wait_s": 2,
        }, 3)
        await lookup_transform("arm/base", "camera/optical", timeout_s=0)
        self.assertEqual(vars(io._request.call_args.args[1]["stamp"]), {"sec": 0, "nanosec": 0})
        for error in (RPCError("missing frame"), TimeoutError(), asyncio.CancelledError()):
            io._request.side_effect = error
            with self.assertRaises(type(error)) as caught:
                await lookup_transform("arm/base", "camera/optical")
            self.assertIs(caught.exception, error)

    async def test_missing_service_and_invalid_timeout_do_not_fall_back(self):
        io = self.enterContext(ambient(NS(frame_service=None, supervised=True, transforms=Mock())))
        with self.assertRaises(RPCError) as caught:
            await lookup_transform("world/base", "arm/tool")
        self.assertEqual(caught.exception.code, "frames_unavailable")
        for timeout in (-1, 31, float("nan"), float("inf")):
            with self.assertRaises(ValueError):
                await lookup_transform("world/base", "arm/tool", timeout_s=timeout)
        io.transforms.assert_not_called()

    async def test_standalone_uses_communication_owned_history(self):
        time = ModuleType("rclpy.time")
        time.Time = Mock()
        buffer = Mock()
        io = self.enterContext(ambient(NS(frame_service=None, supervised=False, transforms=Mock(return_value=buffer), _future=AsyncMock())))
        stamp = object()
        with patch.dict(sys.modules, {"rclpy.time": time}):
            result = await lookup_transform("world:base", "arm:tool", stamp)
            self.assertIs(result, buffer.lookup_transform.return_value)
            time.Time.from_msg.assert_called_once_with(stamp)
            buffer.wait_for_transform_async.assert_called_once_with("world/base", "arm/tool", time.Time.from_msg.return_value)
            io._future.assert_awaited_once_with(buffer.wait_for_transform_async.return_value, 5)
            buffer.lookup_transform.assert_called_once_with("world/base", "arm/tool", time.Time.from_msg.return_value)
            io._future.reset_mock()
            await lookup_transform("world/base", "arm/tool", timeout_s=0)
            io._future.assert_not_awaited()
            buffer.lookup_transform.assert_called_with("world/base", "arm/tool", time.Time.return_value)


def scope(catalog):
    """A Communication with its ROS teardown stubbed."""
    from kinex.communication import Communication
    io = Communication(catalog)
    io.opened = True
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
            await io.close(error)
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
            await io.close()
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
        from kinex.common.plain import plain

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
            for image in (Image(), Path("plot.png")):
                with self.assertRaisesRegex(TypeError, "exec result"):
                    plain({"image": image})
            stamped = Image()
            stamped.header = NS(frame_id="camera/color", stamp=NS(sec=2, nanosec=500000000))
            response, files = Frame_Response(), []
            response.image = stamped
            with patch("kinex.common.camera.save", lambda image: "/tmp/frame.png"):
                value = plain({"view": response, "plot": Path("plot.png"), "depth": (stamped, 1.5)}, files)
            reference = {"file": "/tmp/frame.png", "frame": "camera/color", "stamp": 2.5}
            self.assertEqual(value, {"view": {"image": reference}, "plot": "plot.png", "depth": [reference, 1.5]})
            self.assertEqual(files, ["/tmp/frame.png", "plot.png", "/tmp/frame.png"])


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

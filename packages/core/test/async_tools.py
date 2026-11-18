"""Lib programs use protocol operations through the ambient scope; numerical payloads stay in Python."""
import asyncio
from pathlib import Path
import sys
from types import SimpleNamespace as NS, ModuleType
import unittest
from unittest.mock import AsyncMock, Mock, patch

import numpy as np
# Loaded before any test swaps sys.modules: an extension module loads once per process.
from scipy.spatial.transform import RigidTransform

from kinex import lib
from kinex.communication import ambient
from kinex.values import components, pose
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

    def test_a_pose_is_taken_in_any_form_and_written_as_seven_numbers(self):
        message = NS(header=NS(), pose=NS(position=NS(x=1., y=2., z=3.), orientation=NS(x=0., y=0., z=0., w=1.)))
        relation = NS(transform=NS(translation=NS(x=1., y=2., z=3.), rotation=NS(x=0., y=0., z=0., w=1.)))
        for value in ([1, 2, 3, 0, 0, 0, 1], (1, 2, 3, 0, 0, 0, 1), np.array([1, 2, 3, 0, 0, 0, 1.]), message, message.pose, relation, relation.transform):
            self.assertIsInstance(pose(value), RigidTransform)
            self.assertEqual(components(value).tolist(), [1, 2, 3, 0, 0, 0, 1])
        made = pose([1, 2, 3, 0, 0, 0, 1])
        self.assertIs(pose(made), made)
        # Poses compose and invert as objects; several rows are one batch.
        self.assertEqual(components(made * pose([0, 0, .5, 0, 0, 0, 1])).tolist(), [1, 2, 3.5, 0, 0, 0, 1])
        self.assertEqual(components(made.inv() * made).round(12).tolist(), [0, 0, 0, 0, 0, 0, 1])
        batch = pose([[0, 0, 0, 0, 0, 0, 1], [0, 0, 1, 0, 0, 0, 1]])
        self.assertEqual((len(batch), components(batch).shape), (2, (2, 7)))
        with self.assertRaisesRegex(ValueError, "one pose"):
            components(batch, single=True)
        for bad in ([1, 2, 3], [0, 0, 0, 0, 0, 0, 2], [0, 0, 0, 0, 0, 0, float("nan")], "pose", None):
            with self.subTest(bad=bad), self.assertRaises((ValueError, TypeError)):
                pose(bad)

    def test_seconds_reads_numbers_stamps_and_stamped_messages(self):
        from kinex import seconds
        stamp = NS(sec=2, nanosec=500000000)
        self.assertEqual([seconds(value) for value in (2.5, 2, np.float32(2.5), stamp, NS(header=NS(stamp=stamp)))], [2.5, 2., 2.5, 2.5, 2.5])

    def test_kinematics_take_any_sequence_and_return_arrays_and_poses(self):
        import array
        sys.path.insert(0, str(Path(__file__).parent))
        from joint_model import ARM
        from kinex.common.urdf import read_tree
        from kinex.lib.kinematics import JointModel
        arm = JointModel({"type": "joint", "model": {"tip_links": ["tool"]}, "resolved_model": read_tree(None, "base_link", ARM)})
        expected = [1, 0, .2, 0, 0, 0, 1]
        # A joint_state message's position is an array.array; programs also hold tuples and NumPy arrays.
        for positions in ([0, 0, 0], (0, 0, 0), array.array("d", [0, 0, 0]), np.zeros(3), np.zeros(3, dtype=np.float32)):
            found = arm.fk(positions)
            self.assertIsInstance(found, RigidTransform)
            np.testing.assert_allclose(components(found), expected, atol=1e-12)
        goal = arm.fk([.3, -.4, .02])
        for target in (goal, components(goal), components(goal).tolist()):
            solved = arm.ik(target, np.zeros(3))
            self.assertIsInstance(solved, np.ndarray)
            np.testing.assert_allclose(components(arm.fk(solved)), components(goal), atol=1e-3)
        for bad, message in (({"shoulder": 0}, "must be a sequence of 3 numbers, not dict"), ([0, 0], "needs 3 numbers, got 2"), ("000", "not str")):
            with self.subTest(bad=bad), self.assertRaisesRegex(ValueError, message):
                arm.fk(bad)

    def test_trajectories_are_arrays_from_any_sequence(self):
        joints = [{"name": "a", "type": "revolute", "limits": None}, {"name": "b", "type": "revolute", "limits": None}]
        plan = lib.motion.trajectory(joints, np.zeros(2), (1, .5), .01)
        self.assertEqual((type(plan.actions), plan.actions.shape[1], plan.actions[-1].tolist()), (np.ndarray, 2, [1, .5]))
        self.assertEqual(lib.motion.planning_limits(joints, np.array([.5, .2])).tolist(), [[.5, .2], [3, 3]])


class Transforms(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        messages = ModuleType("builtin_interfaces.msg")
        messages.Time = lambda sec=0, nanosec=0: NS(sec=sec, nanosec=nanosec)
        self.enterContext(patch.dict(sys.modules, {"builtin_interfaces.msg": messages}))

    async def test_service_preserves_frames_stamp_and_errors(self):
        relation = NS(transform=NS(translation=NS(x=1., y=2., z=3.), rotation=NS(x=0., y=0., z=0., w=1.)))
        stamp = NS(sec=2, nanosec=500000000)
        io = self.enterContext(ambient(NS(frame_service=object(), _request=AsyncMock(return_value=relation))))
        found = await lookup_transform("arm:base", "camera/optical", stamp, 2)
        self.assertEqual(components(found).tolist(), [1, 2, 3, 0, 0, 0, 1])
        io._request.assert_awaited_once_with(io.frame_service, {
            "target_frame": "arm/base", "source_frame": "camera/optical", "stamp": stamp, "wait_s": 2,
        }, 3)
        # A pose seen in the source frame moves to the target by a product.
        self.assertEqual(components(found * pose([0, 0, .5, 0, 0, 0, 1])).tolist(), [1, 2, 3.5, 0, 0, 0, 1])
        # A stamped message keeps its own stamp; seconds select the same time; None the latest.
        await lookup_transform("arm/base", "camera/optical", NS(header=NS(stamp=stamp)))
        self.assertIs(io._request.call_args.args[1]["stamp"], stamp)
        await lookup_transform("arm/base", "camera/optical", 2.5)
        self.assertEqual(vars(io._request.call_args.args[1]["stamp"]), {"sec": 2, "nanosec": 500000000})
        await lookup_transform("arm/base", "camera/optical", timeout_s=0)
        self.assertEqual(vars(io._request.call_args.args[1]["stamp"]), {"sec": 0, "nanosec": 0})
        # A frame in itself is the identity and asks no one.
        io._request.reset_mock()
        self.assertEqual(components(await lookup_transform("arm:base", "arm/base")).tolist(), [0, 0, 0, 0, 0, 0, 1])
        io._request.assert_not_awaited()
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
        buffer.lookup_transform.return_value = NS(transform=NS(translation=NS(x=0., y=0., z=1.), rotation=NS(x=0., y=0., z=0., w=1.)))
        io = self.enterContext(ambient(NS(frame_service=None, supervised=False, transforms=Mock(return_value=buffer), _future=AsyncMock())))
        stamp = object()
        with patch.dict(sys.modules, {"rclpy.time": time}):
            result = await lookup_transform("world:base", "arm:tool", stamp)
            self.assertEqual(components(result).tolist(), [0, 0, 1, 0, 0, 0, 1])
            time.Time.from_msg.assert_called_once_with(stamp)
            buffer.wait_for_transform_async.assert_called_once_with("world/base", "arm/tool", time.Time.from_msg.return_value)
            io._future.assert_awaited_once_with(buffer.wait_for_transform_async.return_value, 5)
            buffer.lookup_transform.assert_called_once_with("world/base", "arm/tool", time.Time.from_msg.return_value)
            io._future.reset_mock()
            await lookup_transform("world/base", "arm/tool", timeout_s=0)
            io._future.assert_not_awaited()
            self.assertEqual(vars(time.Time.from_msg.call_args.args[0]), {"sec": 0, "nanosec": 0})
            buffer.lookup_transform.assert_called_with("world/base", "arm/tool", time.Time.from_msg.return_value)


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


class ProgramLoop(unittest.TestCase):
    """exec releases its scope after the program's own event loop has ended."""

    def test_a_scope_closes_in_a_new_loop_after_its_own_ended(self):
        import threading
        rclpy, duration = ModuleType("rclpy"), ModuleType("rclpy.duration")
        duration.Duration = lambda **_: None
        for error, acknowledged, stopped in ((None, True, False), (RuntimeError("failure"), True, True), (None, False, True)):
            io, calls = scope({}), []
            io.enrolled.add("arm")
            io.publishers = {"arm.joint_target": NS(wait_for_all_acked=lambda timeout: acknowledged)}
            io.clock_lock, io.clock_scheduled = threading.Lock(), False

            async def program():
                io.loop = asyncio.get_running_loop()

            async def stop(devices):
                calls.append((devices, io.loop is asyncio.get_running_loop()))

            io._stop = stop
            asyncio.run(program())
            # A message arriving between the loops is dropped, and leaves its delivery free to be scheduled again.
            io._clock_received(NS())
            self.assertFalse(io.clock_scheduled)
            with self.assertRaisesRegex(RuntimeError, "one asyncio.run"):
                io.open()
            with patch.dict(sys.modules, {"rclpy": rclpy, "rclpy.duration": duration}):
                if error is None and not acknowledged:
                    with self.assertRaisesRegex(TimeoutError, "arm.joint_target"):
                        asyncio.run(io.close(error))
                else:
                    asyncio.run(io.close(error))
            self.assertEqual(calls, [(["arm"], True)] if stopped else [])
            self.assertTrue(io.closed)


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

    def test_plain_converts_messages_poses_arrays_records_and_non_finite_numbers(self):
        from dataclasses import dataclass
        from kinex.common.plain import image_file, plain

        def message(module, kind, /, **fields):
            cls = type(kind, (), {"get_fields_and_field_types": lambda self: dict.fromkeys(fields, "")})
            cls.__module__ = module
            value = cls()
            vars(value).update(fields)
            return value

        @dataclass
        class Plan:
            actions: object
            duration_s: float

        def header():
            return message("std_msgs.msg._header", "Header", frame_id="camera/color",
                           stamp=message("builtin_interfaces.msg._time", "Time", sec=2, nanosec=500000000))
        state = message("sensor_msgs.msg._joint_state", "JointState", header=header(), name=["j1"], position=np.array([.5, np.nan]))
        self.assertEqual(plain({"state": state, "pair": (np.float32(2), float("inf")), "tcp": pose([1, 2, 3, 0, 0, 0, 1]),
                                "path": pose([[0, 0, 0, 0, 0, 0, 1], [0, 0, 1, 0, 0, 0, 1]]), "plan": Plan(np.array([[0., 1.]]), 2.5), "raw": b"\x01\x02"}),
                         {"state": {"header": {"frame_id": "camera/color", "stamp": 2.5}, "name": ["j1"], "position": [.5, None]},
                          "pair": [2., None], "tcp": [1, 2, 3, 0, 0, 0, 1], "path": [[0, 0, 0, 0, 0, 0, 1], [0, 0, 1, 0, 0, 0, 1]],
                          "plan": {"actions": [[0, 1]], "duration_s": 2.5}, "raw": [1, 2]})
        self.assertEqual(plain({"plot": Path("plot.png")}), {"plot": "plot.png"})
        # Images are files, never data, at any depth; finish and subagent take them as files.
        image = message("sensor_msgs.msg._image", "Image", header=header(), data=b"")
        for value in (image, [image], message("example_interfaces.srv._frame", "Frame_Response", image=image)):
            with self.assertRaisesRegex(TypeError, "images are not data"):
                plain({"view": value})
        with patch("kinex.common.camera.save", lambda image: "/tmp/frame.png"):
            self.assertEqual([image_file(value) for value in (image, "plot.png", Path("plot.png"), state, 3)],
                             ["/tmp/frame.png", "plot.png", "plot.png", None, None])
        compressed = image_file(message("sensor_msgs.msg._compressed_image", "CompressedImage", format="rgb8; png compressed", data=b"\x89PNG"))
        self.addCleanup(Path(compressed).unlink)
        self.assertEqual((Path(compressed).suffix, Path(compressed).read_bytes()), (".png", b"\x89PNG"))


class Messages(unittest.TestCase):
    """Field mappings become messages by each field's declared type, as rosidl describes it."""

    def setUp(self):
        def kind(module, name, **slots):
            cls = type(name, (), {"__slots__": [f"_{slot}" for slot in slots], "SLOT_TYPES": tuple(slots.values())})
            cls.__module__ = module
            return cls

        def nested(cls, many=False):
            reference = NS(namespaces=cls.__module__.split(".")[:2], name=cls.__name__)
            return NS(value_type=reference) if many else reference

        basic = NS()
        Duration = kind("builtin_interfaces.msg._duration", "Duration", sec=basic, nanosec=basic)
        Vector3 = kind("geometry_msgs.msg._vector3", "Vector3", x=basic, y=basic, z=basic)
        Quaternion = kind("geometry_msgs.msg._quaternion", "Quaternion", x=basic, y=basic, z=basic, w=basic)
        Transform = kind("geometry_msgs.msg._transform", "Transform", translation=nested(Vector3), rotation=nested(Quaternion))
        Point = kind("trajectory_msgs.msg._point", "Point", positions=NS(value_type=basic), transforms=nested(Transform, many=True), time_from_start=nested(Duration))
        self.Trajectory = kind("trajectory_msgs.msg._trajectory", "Trajectory", joint_names=NS(value_type=basic), points=nested(Point, many=True))
        modules = {"builtin_interfaces.msg": NS(Duration=Duration), "geometry_msgs.msg": NS(Vector3=Vector3, Quaternion=Quaternion, Transform=Transform),
                   "trajectory_msgs.msg": NS(Point=Point)}

        def set_message_fields(message, values):
            # As rosidl does: a mapping in a list becomes a message inside the list it was given.
            for name, value in values.items():
                if isinstance(value, list):
                    value[:] = [NS(**item) if isinstance(item, dict) else item for item in value]
                object.__setattr__(message, f"_{name}", value)

        setter = ModuleType("rosidl_runtime_py.set_message")
        setter.set_message_fields = set_message_fields
        self.enterContext(patch.dict(sys.modules, {**modules, "rosidl_runtime_py": ModuleType("rosidl_runtime_py"), "rosidl_runtime_py.set_message": setter}))

    def test_converting_a_payload_leaves_the_callers_mappings_and_lists_alone(self):
        from kinex.communication import message_value
        payload = {"joint_names": ["j1"], "points": [{"positions": [.1]}]}
        message = message_value(self.Trajectory, payload)
        self.assertEqual(payload, {"joint_names": ["j1"], "points": [{"positions": [.1]}]})
        self.assertEqual(message._points[0].positions, [.1])
        self.assertIs(message_value(self.Trajectory, message), message)

    def test_seconds_poses_and_vectors_stand_for_their_messages(self):
        from kinex.communication import message_value
        positions, tips = np.array([.1, .2]), pose([[0, 0, .1, 0, 0, 0, 1], [0, 0, .2, 0, 0, 0, 1]])
        message = message_value(self.Trajectory, {"joint_names": ["tcp"], "points": [
            {"positions": positions, "time_from_start": 1.5, "transforms": tips},
            {"time_from_start": {"sec": 2, "nanosec": 0}, "transforms": [[0, 0, .3, 0, 0, 0, 1], {"translation": (1, 2, 3), "rotation": [0, 0, 0, 1]}]},
        ]})
        first, second = message._points
        self.assertIs(first.positions, positions)
        self.assertEqual(first.time_from_start, {"sec": 1, "nanosec": 500000000})
        self.assertEqual(first.transforms, [{"translation": {"x": 0, "y": 0, "z": z}, "rotation": {"x": 0, "y": 0, "z": 0, "w": 1}} for z in (.1, .2)])
        self.assertEqual(second.time_from_start, {"sec": 2, "nanosec": 0})
        self.assertEqual([entry["translation"] for entry in second.transforms], [{"x": 0, "y": 0, "z": .3}, {"x": 1, "y": 2, "z": 3}])
        with self.assertRaisesRegex(TypeError, "expected Trajectory or field mapping"):
            message_value(self.Trajectory, [1, 2])


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

    async def test_a_scope_opened_by_one_request_closes_in_another(self):
        from kinex.common import frames
        from kinex.communication import Communication
        from kinex.host import device

        def opened(scope):
            scope.node = None
            return scope

        host = device.DeviceHost()
        with patch.object(Communication, "open", opened), patch.object(Communication, "close", AsyncMock()) as close, \
                patch.object(frames, "publish_profile"), patch.object(device.DeviceHost, "ready", AsyncMock()):
            # Each request runs in its own task, as the host's dialog starts them.
            await asyncio.create_task(host.run("load", {"profile": {"name": "arm", "runtime": {}, "operations": {}}}))
            self.assertEqual(await asyncio.create_task(host.run("unload", {})), {"unloaded": True})
        close.assert_awaited_once()
        self.assertIsNone(host.io)


if __name__ == "__main__":
    unittest.main()

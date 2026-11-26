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
        from kinex import device, world
        with self.assertRaisesRegex(RuntimeError, "no communication scope"):
            device("a")
        with ambient(NS(catalog={"a.b": {}}, world=NS(rate=lambda hz: hz))):
            self.assertEqual((device("a").scope.catalog, world.rate(5)), ({"a.b": {}}, 5))
        with self.assertRaises(RuntimeError):
            world.rate(5)

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
    """A lookup reads the scope's tf2 history: the runtime's, which outlives a program, or a standalone scope's own."""

    def setUp(self):
        messages, self.time = ModuleType("builtin_interfaces.msg"), ModuleType("rclpy.time")
        messages.Time = lambda sec=0, nanosec=0: NS(sec=sec, nanosec=nanosec)
        self.time.Time = Mock()
        self.enterContext(patch.dict(sys.modules, {"builtin_interfaces.msg": messages, "rclpy.time": self.time}))
        self.buffer = Mock()
        self.buffer.lookup_transform.return_value = NS(transform=NS(translation=NS(x=1., y=2., z=3.), rotation=NS(x=0., y=0., z=0., w=1.)))
        self.io = self.enterContext(ambient(NS(bridge=NS(transforms=Mock(return_value=self.buffer)), _future=AsyncMock())))

    async def test_lookup_preserves_frames_stamp_and_errors(self):
        io, buffer, time = self.io, self.buffer, self.time.Time
        stamp = NS(sec=2, nanosec=500000000)
        found = await lookup_transform("arm:base", "camera/optical", stamp, 2)
        self.assertEqual(components(found).tolist(), [1, 2, 3, 0, 0, 0, 1])
        time.from_msg.assert_called_once_with(stamp)
        buffer.wait_for_transform_async.assert_called_once_with("arm/base", "camera/optical", time.from_msg.return_value)
        io._future.assert_awaited_once_with(buffer.wait_for_transform_async.return_value, 2)
        buffer.lookup_transform.assert_called_once_with("arm/base", "camera/optical", time.from_msg.return_value)
        # A pose seen in the source frame moves to the target by a product.
        self.assertEqual(components(found * pose([0, 0, .5, 0, 0, 0, 1])).tolist(), [1, 2, 3.5, 0, 0, 0, 1])
        # A stamped message keeps its own stamp; seconds select the same time; None the latest.
        await lookup_transform("arm/base", "camera/optical", NS(header=NS(stamp=stamp)))
        self.assertIs(time.from_msg.call_args.args[0], stamp)
        await lookup_transform("arm/base", "camera/optical", 2.5)
        self.assertEqual(vars(time.from_msg.call_args.args[0]), {"sec": 2, "nanosec": 500000000})
        io._future.reset_mock()
        await lookup_transform("arm/base", "camera/optical", timeout_s=0)  # an immediate lookup waits for nothing
        io._future.assert_not_awaited()
        self.assertEqual(vars(time.from_msg.call_args.args[0]), {"sec": 0, "nanosec": 0})
        # A frame in itself is the identity and asks no one.
        buffer.reset_mock()
        self.assertEqual(components(await lookup_transform("arm:base", "arm/base")).tolist(), [0, 0, 0, 0, 0, 0, 1])
        buffer.lookup_transform.assert_not_called()
        # A lookup that runs out its wait says why; other failures are its own.
        buffer.timed_out.return_value = "camera/optical is not on TF"
        io._future.side_effect = TimeoutError()
        with self.assertRaisesRegex(TimeoutError, "camera/optical is not on TF"):
            await lookup_transform("arm/base", "camera/optical")
        for error in (RPCError("missing frame"), asyncio.CancelledError()):
            io._future.side_effect = error
            with self.assertRaises(type(error)) as caught:
                await lookup_transform("arm/base", "camera/optical")
            self.assertIs(caught.exception, error)

    async def test_an_invalid_timeout_looks_nothing_up(self):
        for timeout in (-1, 31, float("nan"), float("inf")):
            with self.assertRaises(ValueError):
                await lookup_transform("world/base", "arm/tool", timeout_s=timeout)
        self.io.bridge.transforms.assert_not_called()


def scope(catalog, **bridge):
    """A Scope on a bridge whose ROS side is stubbed."""
    from kinex.communication import Scope
    return Scope(NS(**{**dict(catalog=catalog, scopes=set(), spin_error=None, publishers={}, clock=None, world_stamp=None,
                              world_epoch=0, budget=None), **bridge}))


SERVICE = {"transport": "service", "direction": "input"}
# The operations every world declares.
WORLD = {"world.now": {**SERVICE, "type": "custom_interfaces/srv/Now", "endpoint": "/now"},
         "world.wait": {**SERVICE, "type": "custom_interfaces/srv/Wait", "endpoint": "/wait"},
         "world.stop": {**SERVICE, "type": "std_srvs/srv/Trigger", "endpoint": "/world/stop"}}


class Errors(unittest.IsolatedAsyncioTestCase):
    async def test_service_rejection_retains_response_without_replaying_or_stopping(self):
        from kinex.errors import OperationError
        response = NS(success=False, message="episode ended", time_s=1.5)
        convert = ModuleType("rosidl_runtime_py.convert")
        convert.message_to_ordereddict = vars
        with patch.dict(sys.modules, {"rosidl_runtime_py.convert": convert}):
            error = OperationError("world.wait", "custom_interfaces/srv/Wait", response)
        self.assertIs(error.response, response)
        self.assertEqual(error.payload()["details"]["response"]["time_s"], 1.5)
        io, calls = scope(WORLD), []

        async def rejected(*args, **kwargs):
            calls.append((args, kwargs))
            raise error

        io._request = rejected
        with self.assertRaises(OperationError) as caught:
            await io.device("world").service("wait")(seconds=.5)
        self.assertIs(caught.exception, error)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][0][0], "world.wait")
        self.assertEqual(io.enrolled, {"world"})

    async def test_abandoned_wait_stops_its_world(self):
        """A wait the world may still be running, after its request failed or its program stopped waiting."""
        for abandon in ("the request times out", "the program stops waiting"):
            io, endpoints, stopped = scope(WORLD), [], asyncio.Event()

            async def request(reference, spec, fields, timeout_s=None):
                endpoints.append(spec["endpoint"])
                if spec["endpoint"] == "/now":
                    return NS(time_s=0., used_s=float("nan"), max_s=float("nan"))
                if spec["endpoint"] == "/wait":
                    if abandon == "the request times out":
                        raise TimeoutError()
                    await stopped.wait()  # as a world ends the wait its stop cancels
                    return NS(success=False, message="cancelled", time_s=0., ended=[])
                stopped.set()
                return NS(success=True)

            io._request = request
            with self.subTest(abandon), self.assertRaises(TimeoutError):
                await asyncio.wait_for(io.world.wait(60), .05)
            await asyncio.sleep(.01)
            self.assertEqual(endpoints, ["/now", "/wait", "/world/stop"])
            self.assertEqual(io.enrolled, {"world"})
            await io.world.close()

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
        io, calls = scope({}, publishers={"arm.joint_target": NS(wait_for_all_acked=lambda timeout: False)}), []
        io.enrolled.add("arm")
        io.unacknowledged.add("arm.joint_target")

        async def stop(devices):
            calls.append(devices)

        io._stop = stop
        with patch.dict(sys.modules, {"rclpy": rclpy, "rclpy.duration": duration}), \
                self.assertRaisesRegex(TimeoutError, "arm.joint_target"):
            await io.close()
        self.assertEqual(calls, [["arm"]])
        self.assertEqual(io.bridge.publishers.keys(), {"arm.joint_target"})  # the bridge keeps what it made

    async def test_stop_calls_each_declared_stop_service(self):
        io, endpoints = scope({**WORLD, "detector.detect": {"type": "custom_interfaces/srv/Json", "endpoint": "/detect"}}), []

        async def request(reference, spec, fields, timeout_s=None):
            endpoints.append((reference, spec["endpoint"], fields))
            return NS(success=True)

        io._request = request
        await io._stop(["detector", "world"])
        self.assertEqual(endpoints, [("world.stop", "/world/stop", {})])


class ProgramLoop(unittest.TestCase):
    """exec releases its scope after the program's own event loop has ended."""

    def test_naming_a_device_binds_no_loop_and_starts_no_ros(self):
        """A program may name its devices before its loop runs; ROS starts with what it awaits."""
        from kinex.communication import Scope
        catalog = {"arm.joint_state": {"transport": "topic", "direction": "output"}, "arm.move": {"transport": "action", "direction": "input"}}
        io = Scope(catalog=catalog, enroll=AsyncMock())
        arm = io.device("arm")
        self.assertEqual((arm.action("move").spec, arm.topic("joint_state") is arm.topic("joint_state")), (catalog["arm.move"], True))
        self.assertTrue(callable(arm.action("move")))
        self.assertIsNone(io.given)
        for wrong in (lambda: arm.service("move"), lambda: arm.topic("move")):
            with self.assertRaisesRegex(TypeError, "arm.move is a action"):
                wrong()
        with self.assertRaises(RPCError) as caught:
            arm.topic("missing")
        self.assertEqual(caught.exception.code, "operation_unavailable")
        with self.assertRaises(RPCError) as caught:  # only what the host keeps for itself is loaded
            Scope(catalog={"_world.time": {}}, enroll=AsyncMock()).device("arm").topic("joint_state")
        self.assertEqual(caught.exception.code, "devices_not_ready")


class StubWorld:
    """A world for a scope: its now and wait, over a time the waits advance, as a stepped one's does. It executes
    the goals act gives a time to finish at, and ends a wait when one does."""

    def __init__(self):
        self.time, self.budget, self.late, self.asked, self.finishes = 0., (float("nan"), float("nan")), 0., [], {}
        self.io = scope({**WORLD, "arm.move": {"transport": "action", "direction": "input", "type": "x/action/Move"}}).open()
        self.io._request, self.io.act = self.request, self.act

    def act(self, reference, finishes=None):
        """A goal the world finishes at world time finishes, or with None one it does not execute."""
        from kinex.communication import Goal
        goal, done = Goal.__new__(Goal), asyncio.get_running_loop().create_future()
        goal.scope, goal.status, goal.task = self.io, "executing", done
        goal.handle = NS(goal_id=NS(uuid=bytes([len(self.finishes), finishes is None])))
        if finishes is not None:
            self.finishes[goal.handle.goal_id.uuid] = finishes, goal
        return goal

    async def request(self, reference, spec, fields, timeout_s=None):
        if reference == "world.stop":
            return NS(success=True)
        if reference == "world.now":
            return NS(time_s=self.time, used_s=self.budget[0], max_s=self.budget[1])
        seconds = fields["seconds"]
        self.asked.append((None if seconds == float("inf") else round(self.time + seconds, 9), self.io.world.holds))
        await asyncio.sleep(0)
        executing = [(finishes, goal, uuid) for uuid, (finishes, goal) in self.finishes.items() if not goal.task.done()]
        if seconds == float("inf") and not executing:  # nothing would end the wait
            return NS(success=True, message="ok", time_s=self.time, ended=[])
        self.time, self.late = min([self.time + seconds, *(finishes for finishes, _, _ in executing)]) + self.late, 0.
        ended = [(finishes, goal, uuid) for finishes, goal, uuid in executing if finishes <= self.time]
        for finishes, goal, _ in ended:
            goal.status = "succeeded"
            goal.task.set_result(finishes)
        return NS(success=True, message="ok", time_s=self.time, ended=[NS(uuid=uuid) for _, _, uuid in ended])


class WorldTime(unittest.IsolatedAsyncioTestCase):
    async def test_now_is_the_worlds_time_and_budget(self):
        stub = StubWorld()
        self.assertEqual(await stub.io.world.now(), (0., None, None))
        stub.time, stub.budget = 2.5, (1.5, float("inf"))
        self.assertEqual(await stub.io.world.now(), (2.5, 1.5, None))
        with self.assertRaises(RPCError) as caught:
            await scope({}).world.now()
        self.assertEqual(caught.exception.code, "world_unavailable")

    async def test_a_program_awaits_time_and_goals_on_the_world(self):
        stub = StubWorld()
        world = stub.io.world
        slow, fast = stub.io.act("arm.move", 2.), stub.io.act("arm.move", 1.)
        # Awaiting a goal lets the world run to its end, and gives its result.
        self.assertEqual((await fast, (await world.now()).time_s), (1., 1.))
        # Tasks wait at once, for time and for a goal: the world is asked for the earliest time, then for the goal alone.
        stub.asked.clear()
        self.assertEqual(await asyncio.gather(slow, world.wait(.5)), [2., 1.5])
        self.assertEqual((stub.asked, (await world.now()).time_s), ([(1.5, 0), (None, 0)], 2.))
        self.assertEqual(await asyncio.gather(world.wait(.3), world.wait(.1)), [2.3, 2.1])
        self.assertEqual((await world.wait(0), await slow), (2.3, 2.))  # a barrier, and a goal that has ended: no time passes
        # A goal the world does not execute ends elsewhere: awaiting it lets no world time pass.
        foreign = stub.io.act("arm.move")
        asyncio.get_running_loop().call_later(.05, foreign.task.set_result, "elsewhere")
        self.assertEqual((await foreign, (await world.now()).time_s), ("elsewhere", 2.3))
        for bad in ("soon", -1, True, None, float("inf")):
            with self.assertRaisesRegex(TypeError, "nonnegative seconds"):
                await world.wait(bad)
        await asyncio.sleep(.01)  # the driver ends once nothing waits
        self.assertEqual((world.holds, world.waits, world.driver), (0, [], None))

    async def test_loops_at_different_rates_share_the_world_which_rests_while_a_body_runs(self):
        stub = StubWorld()
        world, ticks = stub.io.world, {10: [], 4: []}

        async def loop(hz, count):
            async for now in world.rate(hz):
                ticks[hz].append(round(now, 9))
                with world.hold():  # as a command in flight does
                    await asyncio.sleep(.002)
                await asyncio.sleep(.002)  # a body that awaits anything still holds its tick
                if len(ticks[hz]) == count:
                    break
        await asyncio.gather(loop(10, 6), loop(4, 3))
        self.assertEqual(ticks, {10: [0., .1, .2, .3, .4, .5], 4: [0., .25, .5]})
        # One wait for each deadline, earliest first, and none while a tick's body ran.
        self.assertEqual(stub.asked, [(until, 0) for until in (0., .1, .2, .25, .3, .4, .5)])
        self.assertEqual((world.holds, world.waits, world.driver), (0, [], None))

    async def test_a_tick_whose_time_has_passed_is_skipped(self):
        stub = StubWorld()
        ticks, stub.late = [], 0.

        async def loop():
            async for now in stub.io.world.rate(10):
                ticks.append(round(now, 9))
                if len(ticks) == 2:
                    stub.late = .17  # the world is late for the next tick, as a slow body makes it
                if len(ticks) == 5:
                    break
        await loop()
        self.assertEqual(ticks, [0., .1, .37, .4, .5])  # the tick at 0.2 comes late, the one at 0.3 never
        with self.assertRaises(ValueError):
            stub.io.world.rate(0)


class Dialog(unittest.IsolatedAsyncioTestCase):
    async def test_a_topic_reads_its_stream_and_reopens_it(self):
        from kinex.device import Device

        class Stream:
            def __init__(self):
                self.buffer, self.latest, self.closed, self.timeouts = [], None, False, []

            async def next(self, timeout_s=None):
                self.timeouts.append(timeout_s)
                self.latest = "message"
                return self.latest

            def close(self):
                self.closed = True
                self.latest = None

        spec = {"transport": "topic", "direction": "output", "timeout_s": 3, "qos": {"durability": "transient_local"}}
        catalog, opened = {"arm.state": spec, "arm.target": {"transport": "topic", "direction": "input"}}, []
        io = NS(catalog=catalog, topics={}, operation=lambda reference, transport=None: catalog[reference],
                subscribe=lambda spec, depth: opened.append(Stream()) or opened[-1], publish=AsyncMock())
        state = Device(io, "arm").topic("state")
        self.assertFalse(opened)  # naming a topic subscribes to nothing
        self.assertIsNone(state.latest)
        self.assertEqual((await state.next(), opened[0].timeouts, state.latest), ("message", [3], "message"))
        # A topic that retains its last message is subscribed to again when none is unread: it is sent that message.
        await state.next(timeout_s=1)
        self.assertEqual((len(opened), opened[0].closed, opened[1].timeouts, state.latest), (2, True, [1], "message"))
        opened[1].buffer.append("unread")
        await state.next()
        self.assertEqual(len(opened), 2)
        state.close()
        self.assertTrue(opened[1].closed)
        async for message in state:  # following it opens it again
            break
        self.assertEqual((len(opened), opened[2].timeouts), (3, [None]))
        target = Device(io, "arm").topic("target")
        await target.publish({"data": 1})
        io.publish.assert_awaited_once_with("arm.target", {"data": 1})
        with self.assertRaisesRegex(TypeError, "not a device output"):
            target.latest

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


class FrameGraph(unittest.TestCase):
    """Whose frames a lookup may use across device hosts' lives; tf2's own history is stood in for."""

    def setUp(self):
        class Buffer:
            def __init__(self, cache_time=None):
                pass

            def set_transform(self, value, authority):
                pass

            def set_transform_static(self, value, authority):
                pass

        tf2, duration = ModuleType("tf2_ros"), ModuleType("rclpy.duration")
        tf2.Buffer, tf2.TransformListener = Buffer, None
        tf2.TransformException = type("TransformException", (Exception,), {})
        tf2.LookupException = type("LookupException", (tf2.TransformException,), {})
        duration.Duration = lambda **_: None
        self.enterContext(patch.dict(sys.modules, {"tf2_ros": tf2, "rclpy": ModuleType("rclpy"), "rclpy.duration": duration}))
        from kinex.host.frame_graph import FrameBuffer
        self.graph = FrameBuffer()

    @staticmethod
    def frame(parent, child):
        return NS(header=NS(frame_id=parent, stamp=NS(sec=0, nanosec=0)), child_frame_id=child)

    def test_a_reloaded_device_keeps_what_its_new_host_published_before_it_was_loaded(self):
        graph, mount, link = self.graph, self.frame("world/base", "camera/base"), self.frame("camera/base", "camera/pan")
        graph.set_transform_static(mount, "host")
        graph.device("camera", True)
        self.assertTrue(graph.connected("world/base", "camera/base"))
        graph.device("camera", False)
        self.assertEqual(graph.edges(), {})
        # The next host latches its mounts once, and moves, before its device is announced loaded.
        graph.set_transform_static(mount, "host")
        graph.set_transform(link, "host")
        self.assertFalse(graph.connected("world/base", "camera/pan"))
        self.assertEqual(graph.explain("world/base", "camera/pan", None), "camera is not loaded")
        graph.device("camera", True)
        self.assertTrue(graph.connected("world/base", "camera/pan"))

    def test_a_host_that_never_loaded_leaves_no_frames_to_a_later_one(self):
        graph, mount, lens = self.graph, self.frame("world/base", "camera/base"), self.frame("camera/base", "camera/lens")
        graph.device("camera", False)  # no live host: one is about to start
        graph.set_transform_static(mount, "host")
        graph.set_transform_static(lens, "host")
        self.assertFalse(graph.connected("world/base", "camera/lens"))
        graph.device("camera", False)  # no live host: that one ended without loading
        self.assertEqual(graph.edges(), {})
        # The next host no longer publishes the lens, whose calibration became unknown.
        graph.set_transform_static(mount, "host")
        graph.device("camera", True)
        self.assertTrue(graph.connected("world/base", "camera/base"))
        self.assertFalse(graph.connected("world/base", "camera/lens"))
        self.assertEqual(graph.explain("world/base", "camera/lens", None), "camera/lens is not on TF; camera has camera/base")


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

"""Bundled tools use protocol operations; numerical payloads stay in Python."""
import importlib.util
from pathlib import Path
import sys
from types import SimpleNamespace as NS, ModuleType
import unittest
from unittest.mock import patch

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
        self.catalog = {"arm.ik": {}, "world.wait": {}}
        self.events = []
        self.streams = []

    def subscribe(self, operation, **_):
        self.events.append(("subscribe", operation))
        stream = Stream()
        self.streams.append(stream)
        return stream

    async def request(self, operation, **fields):
        self.events.append(("request", operation, fields))
        if operation == "arm.ik":
            return NS(joints=[.2, .3])
        if operation == "model.infer":
            return {"actions": [[.2, .3], [.4, .5]]}
        return NS(success=True)

    async def publish(self, operation, fields):
        self.events.append(("publish", operation, fields))
        return "accepted-command"

    async def accepted(self, operation, identifier):
        self.events.append(("accepted", operation, identifier))


def profile(_):
    return {
        "name": "arm", "type": "joint", "loaded": True,
        "runtime": {},
        "resolved_model": {"joints": [
            {"name": name, "type": "revolute", "limits": {"min": -1., "max": 1.},
             "max_velocity": 1., "max_acceleration": 3.} for name in ("j0", "j1")
        ]},
        "intrinsics": {"control": {"mode": "position"}, "home": None,
                       "kinematics": {"frame": "flange", "ik": "driver"}},
    }


class Tools(unittest.IsolatedAsyncioTestCase):
    async def test_servo_orders_feedback_accepts_before_world_wait_and_closes_stream(self):
        servo, io = tool("servo"), Protocol()
        with patch.object(servo, "profile", profile):
            result = await servo.main({"device": "arm", "pose": [0, 0, 0, 0, 0, 0, 1]}, io)
        ik = next(event for event in io.events if event[:2] == ("request", "arm.ik"))
        self.assertEqual(ik[2]["seed"], [0., .1])
        self.assertEqual(ik[2]["target"], {"position": {"x": 0., "y": 0., "z": 0.},
                                         "orientation": {"x": 0., "y": 0., "z": 0., "w": 1.}})
        self.assertEqual(result["joints"], [.2, .3])
        self.assertEqual(io.events[-2][:2], ("accepted", "arm.joint_target"))
        self.assertEqual(io.events[-1][:2], ("request", "world.wait"))
        self.assertEqual(io.events[-1][2]["duration_s"], result["duration_s"])
        publication = next(event[2] for event in io.events if event[0] == "publish")
        self.assertEqual(publication["trajectory"]["joint_names"], ["j0", "j1"])
        self.assertEqual(publication["trajectory"]["points"][-1]["positions"], [.2, .3])
        self.assertTrue(all(stream.closed for stream in io.streams))

    async def test_servo_invalid_target_cannot_replace_motion(self):
        servo, io = tool("servo"), Protocol()
        with patch.object(servo, "profile", profile):
            with self.assertRaises(ValueError):
                await servo.main({"device": "arm", "joints": [5., 0.]}, io)
        self.assertFalse(any(event[0] == "publish" for event in io.events))
        self.assertTrue(io.streams[0].closed)

    async def test_policy_validates_chunk_before_publishing(self):
        policy, io = tool("run-policy"), Protocol()
        convert = ModuleType("rosidl_runtime_py.convert")
        convert.message_to_ordereddict = lambda value: value
        with patch.object(policy, "profile", profile), patch.dict(sys.modules, {
            "rosidl_runtime_py": ModuleType("rosidl_runtime_py"),
            "rosidl_runtime_py.convert": convert,
        }):
            result = await policy.main({"model": "model", "observation": {},
                                        "command": [{"device": "arm"}], "action_hz": 20}, io)
        self.assertEqual(result["actions_submitted"], 2)
        self.assertEqual(result["duration_s"], .1)
        self.assertEqual(result["execution_ids"], {"arm": "accepted-command"})
        self.assertEqual(io.events[-1][0], "accepted")

    async def test_relative_pose_uses_tf2_relation_and_local_offsets(self):
        relative = tool("relative-pose")
        async def lookup(io, target, source, stamp):
            self.assertEqual((target, source), ("base", "camera"))
            return NS(transform=NS(translation=NS(x=1., y=0., z=0.),
                                   rotation=NS(x=0., y=0., z=0., w=1.)),
                      header=NS(stamp=NS(sec=2, nanosec=500000000)))
        with patch("kinex.ros_tools.lookup", lookup), patch("kinex.ros_tools.relative_pose",
            return_value=[1., 0., .2, 0., 0., 0., 1.]) as offsets:
            result = await relative.main({"parent": {"frame": "base"},
                                          "child": {"frame": "camera", "pose": [0, 0, .2, 0, 0, 0, 1]}}, Protocol())
        self.assertEqual(result["pose"], [1., 0., .2, 0., 0., 0., 1.])
        self.assertEqual(result["timestamp"], 2.5)
        self.assertEqual(offsets.call_args.args[1:], ([0., 0., .2, 0., 0., 0., 1.], [0., 0., 0., 0., 0., 0., 1.]))

    async def test_policy_cartesian_chunk_uses_scoped_frames_and_typed_ik(self):
        policy = tool("run-policy")

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
        with patch.object(policy, "profile", profile), patch("kinex.ros_tools.transform_pose", transform), patch.dict(sys.modules, {
            "rosidl_runtime_py": ModuleType("rosidl_runtime_py"),
            "rosidl_runtime_py.convert": convert,
        }):
            result = await policy.main({"model": "model", "observation": {},
                                        "command": [{"device": "arm", "space": "pose"}], "action_hz": 20}, io)
        self.assertEqual(frames, [("arm/flange", "arm/flange"), ("arm/flange", "arm"), ("arm", "arm")])
        ik = next(event[2] for event in io.events if event[:2] == ("request", "arm.ik"))
        self.assertEqual(ik["target"]["position"], {"x": .1, "y": 0., "z": 0.})
        self.assertEqual(result["actions_submitted"], 1)


    async def test_servo_rejects_removed_options_and_missing_world_before_publication(self):
        servo = tool("servo")
        for extra in ({"duration_s": 1}, {"ik": {}}, {"max_joint_delta": 1},
                      {"block": "yes"}, {"pose": [0, 0, 0, 0, 0, 0, 1]}, {"frame": "world"}):
            io = Protocol()
            with patch.object(servo, "profile", profile), self.assertRaises(ValueError):
                await servo.main({"device": "arm", "joints": [0, 0], **extra}, io)
            self.assertFalse(any(event[0] == "publish" for event in io.events))
        io = Protocol()
        del io.catalog["world.wait"]
        with patch.object(servo, "profile", profile), self.assertRaisesRegex(ValueError, "world"):
            await servo.main({"device": "arm", "joints": [0, 0]}, io)
        with patch.object(servo, "profile", profile):
            await servo.main({"device": "arm", "joints": [0, 0], "block": False}, io)
        self.assertFalse(any(event[:2] == ("request", "world.wait") for event in io.events))

    async def test_servo_preserves_home_recovery_and_native_limit_handling(self):
        servo = tool("servo")
        for native, home, accepted in [(False, True, True), (False, False, False), (True, False, True)]:
            io = Protocol()
            stream = Stream()
            async def next(**_):
                return NS(name=["j0", "j1"], position=[1.005, 0.], header=NS(stamp=0))
            stream.next = next
            io.subscribe = lambda *args, **kwargs: stream
            facts = profile("arm")
            facts["intrinsics"]["home"] = {"j0": 0., "j1": 0.} if home else None
            if native:
                facts["intrinsics"]["control"]["limit_handling"] = "native"
            with patch.object(servo, "profile", return_value=facts):
                try:
                    await servo.main({"device": "arm", "joints": [0., 0.], "block": False}, io)
                except ValueError:
                    self.assertFalse(accepted)
                else:
                    self.assertTrue(accepted)
            self.assertEqual(any(event[0] == "publish" for event in io.events), accepted)

    async def test_duplicate_or_missing_measured_joints_never_publish(self):
        servo = tool("servo")
        for names, values in [(["j0", "j0"], [0., 0.]), (["j0"], [0.]), (["j0", "j1"], [0.]),
                              (["j0", "j1"], [float("nan"), 0.])]:
            io, stream = Protocol(), Stream()
            async def next(**_):
                return NS(name=names, position=values, header=NS(stamp=0))
            stream.next = next
            io.subscribe = lambda *args, **kwargs: stream
            with patch.object(servo, "profile", profile), self.assertRaises(ValueError):
                await servo.main({"device": "arm", "joints": [0, 0], "block": False}, io)
            self.assertFalse(any(event[0] == "publish" for event in io.events))
            self.assertTrue(stream.closed)

    async def test_policy_invalid_later_joint_target_never_publishes(self):
        policy, io = tool("run-policy"), Protocol()
        async def request(*args, **kwargs):
            return {"actions": [[0., 0.], [5., 0.]]}
        io.request = request
        convert = ModuleType("rosidl_runtime_py.convert")
        convert.message_to_ordereddict = lambda value: value
        with patch.object(policy, "profile", profile), patch.dict(sys.modules, {
            "rosidl_runtime_py": ModuleType("rosidl_runtime_py"), "rosidl_runtime_py.convert": convert,
        }), self.assertRaises(ValueError):
            await policy.main({"model": "model", "observation": {}, "command": [{"device": "arm"}]}, io)
        self.assertFalse(any(event[0] == "publish" for event in io.events))

    async def test_policy_malformed_ik_truncates_all_buffers_and_seeds_from_predecessor(self):
        policy = tool("run-policy")
        for failure_at in (0, 1):
            io, seeds = Protocol(), []
            async def request(operation, **fields):
                if operation == "model.infer":
                    return {"actions": [{"arm": [0, 0, 0, 0, 0, 0, 1], "other": [0., 0.]}] * 3}
                seeds.append(fields["seed"])
                return NS(joints=[.2, .3] if len(seeds) <= failure_at else [5., 0.])
            async def transform(io, pose, *args):
                return pose
            io.request = request
            convert = ModuleType("rosidl_runtime_py.convert")
            convert.message_to_ordereddict = lambda value: value
            with patch.object(policy, "profile", profile), patch("kinex.ros_tools.transform_pose", transform), patch.dict(sys.modules, {
                "rosidl_runtime_py": ModuleType("rosidl_runtime_py"), "rosidl_runtime_py.convert": convert,
            }):
                result = await policy.main({"model": "model", "observation": {}, "action_hz": 20,
                    "command": [{"device": "arm", "space": "pose"}, {"device": "other"}]}, io)
            self.assertEqual(result["actions_submitted"], failure_at)
            self.assertEqual(result["duration_s"], failure_at / 20)
            self.assertEqual(seeds, [[0., .1], [.2, .3]][:failure_at + 1])
            self.assertEqual(len([event for event in io.events if event[0] == "publish"]), 2 if failure_at else 0)



class Errors(unittest.IsolatedAsyncioTestCase):
    async def test_service_rejection_retains_response_without_replaying_or_cancelling(self):
        from kinex.communication import Communication
        from kinex.errors import OperationError
        response = NS(success=False, message="episode ended", time_s=1.5, waited_s=.1)
        convert = ModuleType("rosidl_runtime_py.convert")
        convert.message_to_ordereddict = vars
        with patch.dict(sys.modules, {"rosidl_runtime_py.convert": convert}):
            error = OperationError("world.wait", "kinex_interfaces/srv/Wait", response)
        self.assertIs(error.response, response)
        self.assertEqual(error.payload()["details"]["response"]["time_s"], 1.5)
        io = Communication({"world.wait": {
            "transport": "service", "direction": "input",
            "type": "kinex_interfaces/srv/Wait", "endpoint": "/wait",
            "cancellation": {"type": "kinex_interfaces/srv/CancelWait", "endpoint": "/cancel"},
        }})
        calls = []

        async def rejected(*args, **kwargs):
            calls.append((args, kwargs))
            raise error

        io._request = rejected
        with self.assertRaises(OperationError) as caught:
            await io.request("world.wait", duration_s=.5)
        self.assertIs(caught.exception, error)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][1]["operation"], "world.wait")
        self.assertFalse(io.waits)

    async def test_acceptance_signature_failure_is_actionable(self):
        from kinex.communication import Communication
        with self.assertRaisesRegex(ValueError, "requires \\(operation, command_id\\)"):
            await Communication({}).accepted("ticket")


if __name__ == "__main__":
    unittest.main()

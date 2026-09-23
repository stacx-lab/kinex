"""Exercise buffered execution through the actual shipped driver and planner."""

import copy
import importlib.util
from pathlib import Path
import math
import unittest

from kinex.joint_driver import Driver
from kinex.trajectory import trajectory, planning_limits
from kinex.joints import JointDevice


PROFILE = {
    "name": "arm", "type": "joint", "intrinsics": {
        "model": {"format": "joints", "joints": [{"name": "j", "type": "revolute",
            "limits": {"min": -2, "max": 2}, "max_velocity": 0.5, "max_acceleration": 1.0}]},
        "home": None, "frames": {}, "control": {"mode": "position"},
        "feedback": {"velocities": True, "efforts": False},
    },
}


class Adapter(Driver):

    def __init__(self, mode="stepped", rate=1.0):
        self.profile = copy.deepcopy(PROFILE)
        self.profile["intrinsics"]["control"]["execution"] = mode
        self.q = self.target = self.clock = 0.0
        self.rate, self.stops, self.references = rate, 0, []
        self._model = JointDevice(self.profile)

    def connection(self):
        return self

    def sample(self):
        return {"positions": [self.q], "velocities": [0.0], "efforts": [],
                "faults": [], "sample_time_s": self.clock}

    def servo(self, handle, target, period_s):
        self.target = target[0]
        self.references.append(self.target)
        self.q += max(-self.rate * period_s, min(self.rate * period_s, self.target-self.q))
        self.clock += period_s
        return {"elapsed_s": period_s, "state": self.sample()}

    def halt(self, handle):
        self.target = self.q
        self.stops += 1


class MotionTests(unittest.TestCase):
    def test_write_leaves_mode_specific_reference_without_arrival_wait(self):
        for mode in ("stepped", "realtime"):
            driver = Adapter(mode)
            result = driver.execute("write", {"actions": [[1], [1]], "freq_hz": 100})
            self.assertEqual(result["completed_actions"], 2)
            self.assertAlmostEqual(result["elapsed_s"], .02)
            self.assertAlmostEqual(driver.q, .02)
            self.assertEqual(driver.target, driver.q if mode == "stepped" else 1)

    def test_write_accepts_arbitrary_rates_without_a_profile_clock(self):
        for frequency in (3, 30, 123.4, 1000):
            driver = Adapter("realtime")
            result = driver.execute("write", {"actions": [[.1], [.2], [.3]], "freq_hz": frequency})
            self.assertEqual(result["completed_actions"], 3)
            self.assertAlmostEqual(result["elapsed_s"], 3 / frequency)
            self.assertEqual(driver.references, [.1, .2, .3])

    def test_planner_obeys_limits_and_uses_shortest_continuous_joint_path(self):
        joints = copy.deepcopy(PROFILE["intrinsics"]["model"]["joints"])
        points = trajectory(joints, [0], [1], .01)
        values = [0] + [p[0] for p in points]
        speeds = [(b-a) / .01 for a, b in zip(values, values[1:])]
        accelerations = [(b-a) / .01 for a, b in zip([0]+speeds, speeds+[0])]
        self.assertLessEqual(max(speeds), .5 + 1e-8)
        self.assertLessEqual(max(map(abs, accelerations)), 1.0 + 1e-8)
        self.assertEqual(points[-1], [1])
        joints[0].update(type="continuous", limits=None)
        points = trajectory(joints, [math.pi-.1], [-math.pi+.1], .01)
        self.assertAlmostEqual(points[-1][0], math.pi+.1)
        joints[0].pop("max_acceleration")
        self.assertTrue(trajectory(joints, [0], [1], .01))

    def test_upper_layer_plans_buffers_and_checks_arrival_with_a_hard_budget(self):
        spec = importlib.util.spec_from_file_location("move_to_tool",
            Path(__file__).parents[1] / "assets/builtin/tool/move-to/tool.py")
        tool = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(tool)
        for budget, reached in ((5, True), (.13, False)):
            driver = Adapter(rate=100)
            calls = []
            def write(name, action, **args):
                calls.append(args["freq_hz"])
                return {"data": driver.execute(action, args)}
            tool.device = write
            tool.read = lambda name: driver.sample()
            tool.stop_all = lambda names: driver.stop_motion(driver)
            outcome = tool.follow_trajectory("arm", driver.model().joints, [.1], {
                "joint_tolerance": [.001], "quiet_velocity": [.001], "stable_s": .1,
            }, budget, 1)
            self.assertEqual(outcome["reached"], reached)
            self.assertLessEqual(outcome["elapsed_s"], budget + 1e-8)
            self.assertEqual(calls[0], 10)
            self.assertIn(100, calls)
            if reached:
                self.assertEqual(calls[-1], 10)
                self.assertGreater(len(calls), 1)
                self.assertAlmostEqual(driver.q, .1)
            else:
                self.assertEqual(driver.target, driver.q)

    def test_planning_rates_use_available_limits_and_unit_specific_defaults(self):
        joints = [
            {"type": "revolute", "max_velocity": .2},
            {"type": "prismatic", "max_acceleration": .03},
            {"type": "continuous", "max_velocity": None, "max_acceleration": None},
        ]
        self.assertEqual(planning_limits(joints), [[.2, .1, 1], [3, .03, 3]])
        self.assertEqual(planning_limits(joints, [.1, .02, .3], [2, 2, 2]),
                         [[.1, .02, .3], [2, .03, 2]])
        self.assertEqual(planning_limits(joints, 1, 1), [[.2, 1, 1], [1, .03, 1]])
        joints[2].update(max_velocity=1000, max_acceleration=1000)
        self.assertEqual(planning_limits(joints), [[.2, .1, 1], [3, .03, 3]])
        for bad in (0, -1, True, float("nan"), [1]):
            with self.assertRaises(ValueError):
                planning_limits(joints, max_velocity=bad)

    def test_unknown_limits_still_produce_smooth_references_and_speed_scaling(self):
        for kind, velocity, acceleration, distance in (
            ("revolute", 1, 3, 1), ("prismatic", .1, .3, .1),
        ):
            joints = [{"type": kind, "limits": {"min": -2, "max": 2}}]
            points = trajectory(joints, [0], [distance], .01)
            values = [0] + [p[0] for p in points]
            speeds = [(b-a) / .01 for a, b in zip(values, values[1:])]
            changes = [(b-a) / .01 for a, b in zip([0]+speeds, speeds+[0])]
            self.assertLessEqual(max(speeds), velocity + 1e-8)
            self.assertLessEqual(max(map(abs, changes)), acceleration + 1e-8)
            self.assertEqual(points[-1], [distance])
            self.assertGreater(len(trajectory(joints, [0], [distance], .01, .5)), len(points))

    def test_executor_rejects_an_early_servo_acknowledgment(self):
        driver = Adapter()
        driver.servo = lambda *_: {"elapsed_s": 0, "state": driver.sample()}
        with self.assertRaisesRegex(ValueError, "before its action period"):
            driver.execute("write", {
                "actions": [[.2]], "freq_hz": 100, "for_s": 1,
            })
        self.assertEqual(driver.stops, 1)

    def test_bounded_write_partial_period_counts_only_completed_actions(self):
        driver = Adapter("realtime")
        result = driver.execute("write", {
            "actions": [[.2], [.4], [.6]], "freq_hz": 50, "for_s": .035,
        })
        self.assertEqual(result["completed_actions"], 1)
        self.assertEqual(result["terminated_by"], "timeout")
        self.assertEqual(driver.target, driver.q)
        self.assertNotIn(.6, driver.references)


if __name__ == "__main__":
    unittest.main()

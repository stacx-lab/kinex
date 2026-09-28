"""Exercise trajectory duration and planning limits."""

import copy
import math
import unittest

from kinex.trajectory import trajectory, planning_limits


PROFILE = {
    "name": "arm", "type": "joint", "intrinsics": {
        "model": {"format": "joints", "joints": [{"name": "j", "type": "revolute",
            "limits": {"min": -2, "max": 2}, "max_velocity": 0.5, "max_acceleration": 1.0}]},
        "home": None, "frames": {}, "control": {"mode": "position"},
        "feedback": {"velocities": True, "efforts": False},
    },
}


class MotionTests(unittest.TestCase):
    def test_duration_truncates_without_speeding_up_and_pads_goal(self):
        joints = PROFILE["intrinsics"]["model"]["joints"]
        short = trajectory(joints, [0], [1], .01, duration_s=.13)
        self.assertEqual(len(short), 13)
        self.assertLess(short[-1][0], 1)
        long = trajectory(joints, [0], [1], .01, duration_s=5)
        self.assertEqual(len(long), 500)
        self.assertEqual(long[-10:], [[1]] * 10)

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


if __name__ == "__main__":
    unittest.main()

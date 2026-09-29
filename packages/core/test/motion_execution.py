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
    def test_native_commands_pass_raw_targets_and_still_validate_structure(self):
        from kinex.joint_control import command
        from kinex.scalar_control import command as scalar
        from kinex.velocity import command as velocity

        profile = copy.deepcopy(PROFILE)
        args = {"actions": [[100]], "duration_s": .1}
        with self.assertRaises(ValueError):
            command(profile, args)
        profile["intrinsics"]["control"]["limit_handling"] = "native"
        self.assertEqual(command(profile, args), args)
        for target in ([True], [math.nan], [math.inf], [], [1, 2]):
            with self.assertRaises(ValueError):
                command(profile, {**args, "actions": [[0], target]})
        joints = profile["intrinsics"]["model"]["joints"]
        self.assertTrue(trajectory(joints, [2.001], [100], .01, duration_s=.1, check_limits=False))
        tool = {"intrinsics": {"control": {"mode": "position", "bounds": {"min": 0, "max": 1},
            "resolution": None, "speed": None}}}
        self.assertEqual(scalar(tool, {"actions": [0, 1], "duration_s": .1})["actions"], [0, 1])
        for value in (-.001, 1.001, True, math.nan, math.inf):
            with self.assertRaises(ValueError):
                scalar(tool, {"actions": [0, value], "duration_s": .1})
        for bounds in ({"min": -1, "max": 1}, None):
            base = {"type": "velocity", "intrinsics": {"control": {"mode": "motion", "limit_handling": "native",
                "modes": {"drive": {"velocity": {"components": [
                    {"axis": "vx", "units": "m/s", "bounds": bounds}]}, "posture": None}}}}}
            args = {"mode": "drive", "velocity": {"vx": 100}, "duration_s": .1}
            self.assertEqual(velocity(base, args), args)
            for value in (True, math.nan, math.inf):
                with self.assertRaises(ValueError):
                    velocity(base, {**args, "velocity": {"vx": value}})

    def test_near_unit_pose_quaternions_are_normalized_for_ik(self):
        from kinex.joints import JointDevice
        from kinex.motion import pose

        # A live worker rounded its goal quaternion to three decimals: |q| = 1.000068.
        rounded = [0.2, 0, 0.95, 0.964, 0.264, 0.032, 0.011]
        norm = math.hypot(*rounded[3:])
        normalized = pose(rounded)
        self.assertEqual(normalized[:3], rounded[:3])
        self.assertAlmostEqual(math.hypot(*normalized[3:]), 1, places=12)
        for scaled, component in zip(normalized[3:], rounded[3:]):
            self.assertAlmostEqual(scaled * norm, component, places=12)
        self.assertAlmostEqual(math.hypot(*pose([0, 0, 0, 0.71, 0, 0, 0.71])[3:]), 1, places=12)
        for bad, got in (([0] * 7, "0"), ([0, 0, 0, 0, 0, 1.57, 0], "1.57"),
                         ([0, 0, 0, 0.1, 0.2, 0.3, 0.9], "0.974679")):
            with self.assertRaisesRegex(ValueError, rf"^goal requires a unit quaternion \[qx, qy, qz, qw\] \(xyzw\); got norm {got} \(norms within 0.01 of 1 are normalized\)$"):
                pose(bad, "goal")

        joint = {"name": "j", "type": "revolute", "limits": {"min": -2, "max": 2}, "max_velocity": 1, "max_effort": None}
        arm = JointDevice({"type": "joint", "intrinsics": {
            "model": {"format": "joints", "joints": [joint], "chain": [
                {"origin": [0, 0, 0, 0, 0, 0, 1], "joint": 0, "axis": [0, 0, 1], "anchor": [0, 0, 0], "reference": 0},
                {"origin": [1, 0, 0, 0, 0, 0, 1]}]},
            "home": None, "kinematics": {"frame": "tip", "fk": "numerical", "feedback": "fk", "ik": {
                "backend": "numerical", "max_iterations": 100, "damping": 1e-3,
                "position_tolerance_m": 1e-3, "rotation_tolerance_rad": 1e-3}}}})
        # FK at 0.5 rad rounded to three decimals; the residual check uses the normalized goal.
        self.assertAlmostEqual(arm.ik([0.878, 0.479, 0, 0, 0, 0.247, 0.969], [0])["joints"][0], 0.5, delta=2e-3)

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

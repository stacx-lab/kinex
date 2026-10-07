"""Exercise pose validation, trajectory duration and planning limits."""

import copy
import json
import math
import random
import unittest

from kinex.motion import pose, quaternion
from kinex.trajectory import trajectory, planning_limits


PROFILE = {
    "name": "arm", "type": "joint", "intrinsics": {
        "model": {"format": "joints", "joints": [{"name": "j", "type": "revolute",
            "limits": {"min": -2, "max": 2}, "max_velocity": 0.5, "max_acceleration": 1.0}]},
        "home": None, "frames": {}, "control": {"mode": "position"},
        "feedback": {"velocities": True, "efforts": False},
    },
}


class QuaternionTests(unittest.TestCase):
    def test_rounded_quaternions_preserve_position_direction_sign_and_input(self):
        for rotation in ([.964, .264, .032, .011], [0, 0, .707, .707]):
            for sign in (1, -1):
                original = [.2, -.1, .95] + [sign * component for component in rotation]
                before = original.copy()
                result = pose(original)
                norm = math.hypot(*original[3:])
                self.assertEqual(result[:3], original[:3])
                self.assertAlmostEqual(math.hypot(*result[3:]), 1, places=15)
                for actual, component in zip(result[3:], original[3:]):
                    self.assertAlmostEqual(actual * norm, component, places=15)
                result[0] = 99
                self.assertEqual(original, before)

    def test_norm_bounds_are_inclusive_and_adjacent_outside_values_are_rejected(self):
        for norm in (.999, math.nextafter(.999, 1), 1, math.nextafter(1.001, 1), 1.001):
            for sign in (1, -1):
                with self.subTest(norm=norm, sign=sign):
                    self.assertEqual(quaternion([0, 0, 0, sign * norm]), [0, 0, 0, sign])
        for norm in (math.nextafter(.999, 0), math.nextafter(1.001, math.inf), .99, 1.01, 0):
            with self.subTest(norm=norm), self.assertRaises(ValueError) as caught:
                quaternion([0, 0, 0, norm], "goal")
            message = str(caught.exception)
            self.assertIn("goal requires a unit quaternion [qx, qy, qz, qw] (xyzw)", message)
            self.assertIn(f"got norm {norm!r}", message)
            self.assertIn("within 0.001 of 1", message)
        with self.assertRaises(ValueError):
            quaternion([.71, 0, 0, .71])  # Two-decimal rounding can exceed the tolerance.

    def test_invalid_quaternions_and_poses_are_rejected(self):
        for value in (None, {}, [], [0, 0, 1], [0, 0, 0, 0, 1], (0, 0, 0, 1),
                      [0, 0, 1.57, 0], [.1, .2, .3, .9],
                      *([0, 0, 0, v] for v in (True, False, "1", math.nan, math.inf, -math.inf))):
            with self.subTest(value=value), self.assertRaises(ValueError):
                quaternion(value)
        for value in ([0] * 7, [0] * 6, [0] * 8,
                      *([v, 0, 0, 0, 0, 0, 1] for v in (True, "0", math.nan, math.inf))):
            with self.subTest(value=value), self.assertRaises(ValueError):
                pose(value)

    def test_full_precision_geometry_and_json_round_trips_remain_unit(self):
        from kinex.geometry import mat_to_quat, quat_to_mat

        rng = random.Random(0)
        for _ in range(100):
            rotation = mat_to_quat(quat_to_mat([rng.gauss(0, 1) for _ in range(4)]))
            result = pose(json.loads(json.dumps([.1, .2, .3] + rotation)))
            self.assertAlmostEqual(math.hypot(*result[3:]), 1, places=15)
            for actual, expected in zip(result[3:], rotation):
                self.assertAlmostEqual(actual, expected, places=15)

    def test_joint_ik_normalizes_goals_and_retains_fk_residual_verification(self):
        from kinex.joints import JointDevice

        joint = {"name": "j", "type": "revolute", "limits": {"min": -2, "max": 2},
                 "max_velocity": 1, "max_effort": None}
        arm = JointDevice({"type": "joint", "intrinsics": {
            "model": {"format": "joints", "joints": [joint], "chain": [
                {"origin": [0, 0, 0, 0, 0, 0, 1], "joint": 0, "axis": [0, 0, 1],
                 "anchor": [0, 0, 0], "reference": 0},
                {"origin": [1, 0, 0, 0, 0, 0, 1]}]},
            "home": None, "frames": {},
            "kinematics": {"frame": "tip", "fk": "numerical",  "ik": {
                "backend": "numerical", "max_iterations": 100, "damping": 1e-3,
                "frame_to_solver": [0, 0, 0, 0, 0, 0, 1],
                "position_tolerance_m": 1e-3, "rotation_tolerance_rad": 1e-3}}}})
        target = [.878, .479, 0, 0, 0, .247, .969]  # FK at 0.5 rad, rounded to 3 decimals.
        self.assertAlmostEqual(arm.ik(target, [0])["joints"][0], .5, delta=2e-3)

        def native_ik(goal, seed):
            self.assertEqual(goal[:3], target[:3])
            self.assertAlmostEqual(math.hypot(*goal[3:]), 1, places=15)
            return [.5]

        arm.options["backend"] = "driver"
        arm.native_ik = native_ik
        self.assertEqual(arm.ik(target, [0])["joints"], [.5])
        arm.native_ik = lambda goal, seed: [0]
        with self.assertRaisesRegex(ValueError, "IK result failed FK residual verification"):
            arm.ik(target, [0])

    def test_velocity_body_and_frame_readings_without_global_pose(self):
        from kinex.velocity import reading

        profile = {"type": "velocity", "intrinsics": {"frames": {"torso": {"parent_frame": None, "translation_m": None, "rotation_xyzw": None}}, "feedback": {
            "velocity_components": [], "velocity_frame": None}}}
        sample = {"velocities": [], "faults": [], "timestamp": 0, "height_m": .74,
                  "frame_poses": {"torso": [0, 0, .2, 0, 0, 0, 1]}}
        self.assertEqual(reading(profile, sample), sample)
        for value in (None, {"translation_m": [0, 0, 0], "rotation_xyzw": [0, 0, 0, 1]}):
            with self.assertRaisesRegex(ValueError, "global pose"):
                reading(profile, {**sample, "pose": value})
        for value in (True, math.nan, math.inf):
            with self.assertRaises(ValueError):
                reading(profile, {**sample, "height_m": value})
        empty = {**sample, "frame_poses": {}}
        self.assertNotIn("frame_poses", reading(profile, empty))
        del empty["frame_poses"]
        self.assertEqual(reading(profile, empty), empty)
        for frames in ({"missing": [0, 0, 0, 0, 0, 0, 1]}, {"torso": [0, 0, 0, 0, 0, 0, .9995]}, None):
            with self.assertRaises(ValueError):
                reading(profile, {**sample, "frame_poses": frames})


class MotionTests(unittest.TestCase):
    def test_joint_home_recovery(self):
        from kinex.joint_control import command, home_start_tolerance
        profile = copy.deepcopy(PROFILE)
        profile["intrinsics"].update(home={"j": 0})
        joints = profile["intrinsics"]["model"]["joints"]
        tolerance = home_start_tolerance(profile, joints, [0])
        self.assertEqual(tolerance, math.radians(1))
        for sign in (-1, 1):
            plan = trajectory(joints, [sign * (2 + tolerance)], [0], .01, start_tolerance=tolerance)
            command(profile, {"actions": plan.actions, "duration_s": plan.duration_s})
        for points in ([2.09, 0], [2.004, 2.005, 0], [2.004, 1.9, 2.001, 0], [2.004, .1], [2.004]):
            with self.assertRaises(ValueError):
                command(profile, {"actions": [[q] for q in points], "duration_s": 1})
        for home in (None, "???"):
            profile["intrinsics"]["home"] = home
            self.assertEqual(home_start_tolerance(profile, joints, [0]), 0)
            with self.assertRaises(ValueError):
                command(profile, {"actions": [[2.004], [0]], "duration_s": 1})
        profile["intrinsics"].update(home={"j": 0})
        with self.assertRaises(ValueError):
            command(profile, {"actions": [[2 + math.radians(1.01)], [0]], "duration_s": 1})
        self.assertEqual(home_start_tolerance(profile, joints, [.1]), 0)
        joints[0]["type"] = "prismatic"
        with self.assertRaises(ValueError):
            trajectory(joints, [2.001], [0], .01, start_tolerance=tolerance)

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
        self.assertTrue(trajectory(joints, [2.001], [100], .01, check_limits=False).actions)
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

    def test_full_plan_duration_endpoint_and_speed_scaling(self):
        joints = [{"type": "revolute", "limits": {"min": -3, "max": 3}}] * 2
        plan = trajectory(joints, [0, 0], [2, 1], .01)
        self.assertEqual(plan.duration_s, 3.75)
        self.assertEqual(len(plan.actions), 375)
        self.assertEqual(plan.actions[-1], [2, 1])
        slow = trajectory(joints, [0, 0], [2, 1], .01, .5)
        self.assertEqual(slow.duration_s, 7.5)
        self.assertEqual(len(slow.actions), 750)
        self.assertEqual(slow.actions[-1], [2, 1])
        still = trajectory(joints, [1, 1], [1, 1], .01)
        self.assertEqual(still.duration_s, .01)
        self.assertEqual(still.actions, [[1, 1]])
        with self.assertRaises(TypeError):
            trajectory(joints, [0, 0], [2, 1], .01, duration_s=2.5)
        with self.assertRaisesRegex(ValueError, "one million"):
            trajectory(joints, [0, 0], [2, 1], .01, .0001)

    def assert_rates(self, plan, start, velocities, accelerations):
        dt = plan.duration_s / len(plan.actions)
        for i, (velocity, acceleration) in enumerate(zip(velocities, accelerations)):
            values = [start[i]] + [p[i] for p in plan.actions]
            speeds = [(b-a) / dt for a, b in zip(values, values[1:])]
            changes = [(b-a) / dt for a, b in zip([0]+speeds, speeds+[0])]
            self.assertLessEqual(max(map(abs, speeds)), velocity + 1e-8)
            self.assertLessEqual(max(map(abs, changes)), acceleration + 1e-8)

    def test_nonintegral_duration_and_mixed_joint_rate_overrides(self):
        joints = [
            {"type": "revolute", "limits": {"min": -2, "max": 2}, "max_velocity": .5},
            {"type": "prismatic", "limits": {"min": -1, "max": 1}},
        ]
        goal = [.123, .037]
        plan = trajectory(joints, [0, 0], goal, .01, .7, [.8, .2], [.8, .6])
        velocities, accelerations = planning_limits(joints, [.8, .2], [.8, .6])
        self.assertNotAlmostEqual(plan.duration_s / .01, round(plan.duration_s / .01))
        self.assertEqual(len(plan.actions), math.ceil(plan.duration_s / .01))
        self.assertEqual(plan.actions[-1], goal)
        self.assert_rates(plan, [0, 0], [v*.7 for v in velocities], [a*.7 for a in accelerations])

    def test_planner_obeys_limits_and_uses_shortest_continuous_joint_path(self):
        joints = copy.deepcopy(PROFILE["intrinsics"]["model"]["joints"])
        plan = trajectory(joints, [0], [1], .01)
        self.assert_rates(plan, [0], [.5], [1])
        self.assertEqual(plan.actions[-1], [1])
        joints[0].update(type="continuous", limits=None)
        plan = trajectory(joints, [math.pi-.1], [-math.pi+.1], .01)
        self.assertAlmostEqual(plan.actions[-1][0], math.pi+.1)
        joints[0].pop("max_acceleration")
        self.assertTrue(trajectory(joints, [0], [1], .01).actions)

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
            plan = trajectory(joints, [0], [distance], .01)
            self.assert_rates(plan, [0], [velocity], [acceleration])
            self.assertEqual(plan.actions[-1], [distance])
            slow = trajectory(joints, [0], [distance], .01, .5)
            self.assertGreater(slow.duration_s, plan.duration_s)
            self.assert_rates(slow, [0], [velocity*.5], [acceleration*.5])


if __name__ == "__main__":
    unittest.main()

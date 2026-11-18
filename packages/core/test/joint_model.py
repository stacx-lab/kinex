"""URDF joint models: command order, mimic-aware link FK and IK, and tip pose targets without device I/O."""
import math
from types import SimpleNamespace as NS
import unittest

from kinex.common.joints import JointModel, pose_at, pose_command
from kinex.common.geometry import pose_error, slerp
from kinex.common.urdf import read_tree

ARM = """<robot name="arm">
  <link name="base_link"/><link name="upper"/><link name="flange"/><link name="tool"/>
  <link name="left"/><link name="right"/>
  <joint name="shoulder" type="revolute"><parent link="base_link"/><child link="upper"/>
    <axis xyz="0 0 1"/><limit lower="-2" upper="2"/></joint>
  <joint name="elbow" type="revolute"><parent link="upper"/><child link="flange"/>
    <origin xyz="1 0 0"/><axis xyz="0 1 0"/><limit lower="-2" upper="2"/></joint>
  <joint name="tool_joint" type="fixed"><parent link="flange"/><child link="tool"/><origin xyz="0 0 .2"/></joint>
  <joint name="finger" type="prismatic"><parent link="flange"/><child link="left"/>
    <axis xyz="0 1 0"/><limit lower="0" upper=".04"/></joint>
  <joint name="finger_mimic" type="prismatic"><parent link="flange"/><child link="right"/>
    <axis xyz="0 -1 0"/><limit lower="0" upper=".04"/><mimic joint="finger"/></joint>
</robot>"""


def simple(kind="revolute", limits='lower="-1" upper="1"', axis="0 0 1"):
    """One joint moving a flange one metre along x of its child link."""
    return f"""<robot name="arm"><link name="base_link"/><link name="link"/><link name="flange"/>
  <joint name="j" type="{kind}"><parent link="base_link"/><child link="link"/><axis xyz="{axis}"/><limit {limits}/></joint>
  <joint name="flange_joint" type="fixed"><parent link="link"/><child link="flange"/><origin xyz="1 0 0"/></joint></robot>"""


def model(xml=ARM, tips=("tool",)):
    return JointModel({"type": "joint", "model": {"tip_links": list(tips)}, "resolved_model": read_tree(None, "base_link", xml)})


class JointModelTests(unittest.TestCase):
    def assert_pose(self, actual, expected, tolerance=1e-9):
        error = pose_error(actual, expected)
        self.assertLess(error["position_m"], tolerance)
        self.assertLess(error["rotation_rad"], tolerance)

    def test_commanded_joints_follow_document_order_without_mimics(self):
        arm = model()
        self.assertEqual(arm.names, ["shoulder", "elbow", "finger"])
        self.assertEqual(arm.tree["links"], ["base_link", "upper", "flange", "tool", "left", "right"])

    def test_fk_composes_fixed_links_and_mimic_sources(self):
        arm = model()
        self.assert_pose(arm.fk([0, 0, 0]), [1, 0, .2, 0, 0, 0, 1])
        half = math.sqrt(.5)
        self.assert_pose(arm.fk([math.pi / 2, 0, 0]), [0, 1, .2, 0, 0, half, half])
        self.assert_pose(arm.fk([0, 0, .03], "right"), [1, -.03, 0, 0, 0, 0, 1])
        # Measured overshoot is never clamped for FK.
        self.assert_pose(arm.fk([0, 0, .05], "left"), [1, .05, 0, 0, 0, 0, 1])

    def test_ik_solves_the_tip_path_and_keeps_other_joints(self):
        arm = model()
        goal = arm.fk([.3, -.4, .02])
        solved = arm.ik(goal, [0, 0, .01])
        self.assertEqual(solved[2], .01)
        self.assert_pose(arm.fk(solved), goal, 1e-3)
        self.assertAlmostEqual(arm.ik(arm.fk([0, 0, .03], "left"), [0, 0, 0], "left")[2], .03, places=4)

    def test_ik_rejects_mimic_paths_unknown_links_and_missing_tips(self):
        arm = model()
        with self.assertRaisesRegex(ValueError, "independent movable joints"):
            arm.ik(arm.fk([0, 0, .02], "right"), [0, 0, 0], "right")
        with self.assertRaisesRegex(ValueError, "not a link below"):
            arm.fk([0, 0, 0], "missing")
        with self.assertRaisesRegex(ValueError, "declares no tip links"):
            model(tips=()).fk([0, 0, 0])
        hand = model(tips=("tool", "left"))
        with self.assertRaisesRegex(ValueError, "declares 2 tip links"):
            hand.fk([0, 0, 0])
        self.assert_pose(hand.fk([0, 0, .03], "left"), [1, .03, 0, 0, 0, 0, 1])

    def test_unresolved_models_and_unknown_options_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "arm has no resolved URDF model"):
            JointModel({"name": "arm", "type": "joint", "model": "???"})
        arm = model()
        with self.assertRaisesRegex(ValueError, "unknown IK options: tolerance"):
            arm.ik(arm.fk([0, 0, 0]), [0, 0, 0], tolerance=1)

    def test_continuous_and_prismatic_ik(self):
        tight = {"position_tolerance_m": 1e-7, "rotation_tolerance_rad": 1e-7}
        wheel = model(simple("continuous", 'effort="1"'), ("flange",))
        self.assertAlmostEqual(wheel.ik(wheel.fk([.2]), [10 * math.pi], **tight)[0], 10 * math.pi + .2, places=5)
        slider = model(simple("prismatic", 'lower="0" upper="1"', "1 0 0"), ("flange",))
        self.assertAlmostEqual(slider.ik(slider.fk([.8]), [.1], **tight)[0], .8, places=5)


IDENTITY = [0, 0, 0, 1]
TURN = [0, 0, math.sqrt(.5), math.sqrt(.5)]
TIPS = {"name": "arm", "model": {"tip_links": ["tool", "left"]}}


def trajectory(names, points, frame="arm/base"):
    """A MultiDOFJointTrajectory stand-in from (seconds, [[x, y, z, qx, qy, qz, qw], ...]) points."""
    def transform(value):
        return NS(translation=NS(x=value[0], y=value[1], z=value[2]),
                  rotation=NS(x=value[3], y=value[4], z=value[5], w=value[6]))
    return NS(header=NS(frame_id=frame), joint_names=names, points=[
        NS(time_from_start=NS(sec=math.floor(t), nanosec=round((t - math.floor(t)) * 1e9)),
           transforms=[transform(value) for value in values]) for t, values in points])


class PoseTargetTests(unittest.TestCase):
    def assert_close(self, actual, expected):
        self.assertEqual(len(actual), len(expected))
        for a, b in zip(actual, expected):
            self.assertAlmostEqual(a, b, places=9)

    def test_pose_targets_validate_frame_tips_times_and_quaternions(self):
        plan = pose_command(TIPS, trajectory(["tool"], [(0, [[0, 0, 0, 0, 0, 0, 1.0005]]), (1.5, [[1, 0, 0, *TURN]])]))
        self.assertEqual([time_s for time_s, _ in plan], [0, 1.5])
        self.assert_close(plan[0][1]["tool"], [0, 0, 0, *IDENTITY])
        # Position-only tips ignore whatever rotation the message carries.
        self.assertEqual(pose_command(TIPS, trajectory(["left"], [(1, [[1, 2, 3, 0, 0, 0, 0]])]), ("left",)),
                         [(1, {"left": [1, 2, 3]})])
        still = [0, 0, 0, *IDENTITY]
        for bad, message in (
            (trajectory(["tool"], [(1, [still])], "arm/flange"), "expressed in arm/base"),
            (trajectory(["base_link"], [(1, [still])]), "tip links once each"),
            (trajectory(["tool", "tool"], [(1, [still, still])]), "tip links once each"),
            (trajectory([], [(1, [])]), "tip links once each"),
            (trajectory(["tool"], []), "increases strictly"),
            (trajectory(["tool"], [(1, [still]), (1, [still])]), "increases strictly"),
            (trajectory(["tool"], [(-1, [still])]), "increases strictly"),
            (trajectory(["tool", "left"], [(1, [still])]), "one transform per named tip"),
            (trajectory(["tool"], [(1, [[0, 0, 0, 0, 0, 0, 0]])]), "unit quaternion"),
            (trajectory(["tool"], [(1, [[math.nan, 0, 0, *IDENTITY]])]), "finite"),
        ):
            with self.subTest(message=message), self.assertRaisesRegex(ValueError, message):
                pose_command(TIPS, bad)

    def test_pose_at_interpolates_from_the_start_and_keeps_the_last_point(self):
        start = {"tool": [0, 0, 0, *IDENTITY], "left": [0, 0, 0, *TURN]}
        plan = pose_command(TIPS, trajectory(["tool", "left"], [
            (2, [[2, 0, 0, *TURN], [0, 2, 0, *IDENTITY]]), (3, [[2, 1, 0, *TURN], [0, 3, 0, *IDENTITY]])]), ("left",))
        middle = pose_at(start, plan, 1)
        self.assert_close(middle["tool"], [1, 0, 0, 0, 0, math.sin(math.pi / 8), math.cos(math.pi / 8)])
        self.assert_close(middle["left"], [0, 1, 0, *TURN])
        self.assert_close(pose_at(start, plan, 2.5)["tool"], [2, .5, 0, *TURN])
        final = pose_at(start, plan, 9)
        self.assert_close(final["tool"], [2, 1, 0, *TURN])
        self.assert_close(final["left"], [0, 3, 0, *TURN])

    def test_slerp_follows_the_shorter_arc(self):
        self.assert_close(slerp(IDENTITY, [0, 0, 0, -1], .5), IDENTITY)
        self.assert_close(slerp(IDENTITY, TURN, 1), TURN)


if __name__ == "__main__":
    unittest.main()

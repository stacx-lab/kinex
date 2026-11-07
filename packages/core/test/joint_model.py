"""URDF joint models: command order, mimic-aware link FK and IK without device I/O."""
import math
import unittest

from kinex.lib.joints import JointModel
from kinex.lib.geometry import pose_error
from kinex.lib.urdf import read_tree

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


def model(xml=ARM, tip="tool"):
    return JointModel({"type": "joint", "model": {"tip_link": tip}, "resolved_model": read_tree(None, "base_link", xml)})


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
        with self.assertRaisesRegex(ValueError, "no tip_link"):
            model(tip=None).fk([0, 0, 0])

    def test_unresolved_models_and_unknown_options_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "arm has no resolved URDF model"):
            JointModel({"name": "arm", "type": "joint", "model": "???"})
        arm = model()
        with self.assertRaisesRegex(ValueError, "unknown IK options: tolerance"):
            arm.ik(arm.fk([0, 0, 0]), [0, 0, 0], tolerance=1)

    def test_continuous_and_prismatic_ik(self):
        tight = {"position_tolerance_m": 1e-7, "rotation_tolerance_rad": 1e-7}
        wheel = model(simple("continuous", 'effort="1"'), "flange")
        self.assertAlmostEqual(wheel.ik(wheel.fk([.2]), [10 * math.pi], **tight)[0], 10 * math.pi + .2, places=5)
        slider = model(simple("prismatic", 'lower="0" upper="1"', "1 0 0"), "flange")
        self.assertAlmostEqual(slider.ik(slider.fk([.8]), [.1], **tight)[0], .8, places=5)


if __name__ == "__main__":
    unittest.main()

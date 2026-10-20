"""Frame selection, measured-state FK and device-local model geometry."""
import copy
import math
import unittest
from unittest.mock import patch

from kinex.geometry import compose_rt, invert_rt, xyzq_to_rt
from kinex.joints import JointDevice
from kinex.motion import flat, pose_error

IDENTITY = [0, 0, 0, 0, 0, 0, 1]


def definition(value=None, parent=None):
    return {"parent_frame": parent, "translation_m": value[:3] if value else None,
            "rotation_xyzw": value[3:] if value else None}


def profile():
    return {"name": "arm", "type": "joint", "intrinsics": {
        "model": {"format": "serial_chain", "joints": [
            {"name": "j", "type": "revolute", "limits": {"min": -1, "max": 1}}],
            "chain": [{"origin": IDENTITY, "joint": 0, "axis": [0, 0, 1],
                       "anchor": [0, 0, 0], "reference": 0}, {"origin": [1, 0, 0, 0, 0, 0, 1]}]},
        "frames": {"tool": definition([0, .2, 0, 0, 0, 0, 1], "flange"),
                   "fixture": definition([.3, -.1, 0, 0, 0, math.sqrt(.5), math.sqrt(.5)]),
                   "unknown": definition()},
        "kinematics": {"frame": "flange", "fk": "numerical", "frame_to_reported": IDENTITY,
                       "ik": {"backend": "numerical", "method": "damped_least_squares",
                              "max_iterations": 200, "damping": .01,
                              "position_tolerance_m": 1e-6, "rotation_tolerance_rad": 1e-6}},
        "home": None, "feedback": {"velocities": True, "efforts": False}}}


class FrameTests(unittest.TestCase):


    def assert_pose(self, actual, expected):
        error = pose_error(actual, expected)
        self.assertLess(error["position_m"], 1e-6)
        self.assertLess(error["rotation_rad"], 1e-6)

    def test_fk_ik_explicit_pair(self):
        model = JointDevice(profile())
        endpoint = model.fk([.4])
        self.assertEqual((endpoint["frame"], endpoint["reference_frame"]), ("flange", None))
        selected = model.fk([.4], "tool", "fixture")
        fixture = [.3, -.1, 0, 0, 0, math.sqrt(.5), math.sqrt(.5)]
        expected = flat(compose_rt(invert_rt(xyzq_to_rt(fixture)), compose_rt(
            xyzq_to_rt(endpoint["pose"]), xyzq_to_rt([0, .2, 0, 0, 0, 0, 1]))))
        self.assert_pose(selected["pose"], expected)
        solved = model.ik(selected["pose"], [.1], "tool", "fixture")
        self.assertEqual((solved["frame"], solved["reference_frame"]), ("tool", "fixture"))
        self.assert_pose(model.fk(**solved)["pose"], selected["pose"])

    def test_read_has_no_pose_computation_and_fk_preserves_overshoot(self):
        model = JointDevice(profile())
        state = {"positions": [1.01], "velocities": [0], "efforts": [], "faults": [], "timestamp": 7}
        with patch.object(model, "fk", side_effect=AssertionError("read called FK")):
            self.assertEqual(model.reading(state), state)
        self.assertAlmostEqual(model.fk([1.01])["pose"][0], math.cos(1.01))
        with self.assertRaises(ValueError):
            model.ik(model.fk([.4])["pose"], [1.01])

    def test_unknown_and_moving_reference_fail(self):
        model = JointDevice(profile())
        for target, reference in [("unknown", None), ("missing", None), ("tool", "flange"), ("arm:tool", None)]:
            with self.assertRaises(ValueError):
                model.fk([0], target, reference)
        with self.assertRaises(ValueError):
            model.fk([float("nan")])

    def test_native_offsets_and_explicit_pair(self):
        facts = profile()
        expected = JointDevice(copy.deepcopy(facts)).fk([.4], "tool", "fixture")["pose"]
        k = facts["intrinsics"]["kinematics"]
        k["fk"] = "driver"
        k["frame_to_reported"] = [0, 0, .1, 0, 0, 0, 1]
        k["ik"] = {"backend": "driver", "frame_to_solver": [0, 0, .2, 0, 0, 0, 1],
                   "position_tolerance_m": 1e-6, "rotation_tolerance_rad": 1e-6}
        base_model = JointDevice(profile())
        def native_fk(q):
            return flat(compose_rt(xyzq_to_rt(base_model.fk(q)["pose"]), xyzq_to_rt(k["frame_to_reported"])))
        def native_ik(target, seed):
            self.assert_pose(target, flat(compose_rt(xyzq_to_rt(base_model.fk(seed)["pose"]), xyzq_to_rt(k["ik"]["frame_to_solver"]))))
            return seed
        model = JointDevice(facts, native_fk=native_fk, native_ik=native_ik)
        self.assert_pose(model.fk([.4], "tool", "fixture")["pose"], expected)
        self.assertEqual(model.ik(expected, [.4], "tool", "fixture")["joints"], [.4])



    def test_hand_geometry_resolves_without_frame_feedback(self):
        facts = profile()
        facts["type"] = "dexterous_hand"
        intrinsics = facts["intrinsics"]
        chain = intrinsics["model"].pop("chain")
        intrinsics["model"]["format"] = "joints"
        intrinsics["kinematics"] = None
        intrinsics["frames"] = {"palm": definition(IDENTITY), "reference": definition(IDENTITY)}
        chain = [{**link, "joint": "j"} if "joint" in link else link for link in chain]
        intrinsics["geometry"] = {
            "fingers": {"finger": {"chain": chain, "tip_frame": "tip", "tip_offset": IDENTITY}},
            "center": {"frame": "center", "weights": {"finger": 1}, "rotation_xyzw": [0, 0, 0, 1]}}
        model = JointDevice(facts)
        self.assert_pose(model.fk([.4], "tip", "reference")["pose"], JointDevice(profile()).fk([.4])["pose"])
        self.assertAlmostEqual(model.fk([.4], "center")["pose"][0], math.cos(.4))

    def test_hand_optional_geometry_shared_joints_and_fixed_references(self):
        from kinex.hand import forward
        facts = profile()
        facts["type"] = "dexterous_hand"
        intrinsics = facts["intrinsics"]
        old_model = JointDevice(profile())
        chain = intrinsics["model"].pop("chain")
        intrinsics["model"]["format"] = "joints"
        intrinsics["kinematics"] = None
        # Fixed references need no palm/reference selectors and may be unknown.
        intrinsics["frames"] = {"reference": definition(IDENTITY), "unknown": definition()}
        intrinsics["geometry"] = {"description": "One finger."}
        model = JointDevice(facts)
        self.assertEqual(set(model.frames), {"reference", "unknown"})
        with self.assertRaisesRegex(ValueError, "unavailable"):
            forward(facts, [.4])
        chain = [{**link, "joint": "j"} if "joint" in link else link for link in chain]
        intrinsics["geometry"]["fingers"] = {
            name: {"chain": chain, "tip_frame": name, "tip_offset": IDENTITY}
            for name in ("tip", "shared_tip")}
        intrinsics["frames"]["pad"] = definition([0, 0, .1, 0, 0, 0, 1], "tip")
        model = JointDevice(facts)
        for q in (0, -1, 1, 1.002, -.37, .83):
            tips = forward(facts, [q])
            self.assertEqual(set(tips), {"tip", "shared_tip"})
            self.assert_pose(tips["tip"], old_model.fk([q])["pose"])
            self.assert_pose(tips["shared_tip"], tips["tip"])
            self.assert_pose(model.fk([q], "pad", "reference")["pose"],
                             flat(compose_rt(xyzq_to_rt(tips["tip"]), xyzq_to_rt([0, 0, .1, 0, 0, 0, 1]))))
        for invalid in ("missing", 0):
            bad = copy.deepcopy(facts)
            bad["intrinsics"]["geometry"]["fingers"]["tip"]["chain"][0]["joint"] = invalid
            with self.assertRaisesRegex(ValueError, "known model joints"):
                forward(bad, [.4])



if __name__ == "__main__":
    unittest.main()

"""Numerical recovery, deadlines and controller composition without device I/O."""

import copy
import importlib.util
import json
import math
from contextlib import ExitStack
from pathlib import Path
import random
import threading
import unittest
from unittest.mock import Mock, patch

from kinex import driver_protocol, ik_search, kinematics
from kinex.joints import JointDevice
from kinex.motion import pose_error
from joint_frames import profile as simple_profile


FIXTURES = Path(__file__).parent / "fixtures" / "ik"
PANDA = json.loads((FIXTURES / "panda.json").read_text())
CORPUS = json.loads((FIXTURES / "corpus.json").read_text())
RECOVERY = next(case for case in CORPUS["cases"] if case["id"] == "medium34")


class SearchTests(unittest.TestCase):
    def setUp(self):
        self.model = JointDevice(simple_profile())
        self.joints = self.model.joints
        self.options = self.model.options
        self.clock = patch.object(ik_search, "monotonic", return_value=0)
        self.clock.start()
        self.addCleanup(self.clock.stop)

    def test_defaults_and_raw_python_validation(self):
        self.assertEqual(ik_search.search_options({}),
                         {"max_attempts": 5, "attempt_time_s": .02, "max_time_s": .1})
        self.assertEqual(ik_search.search_options({"search": {"max_attempts": 1}})["attempt_time_s"], .02)
        bad = [None, [], {"unknown": 1}]
        bad += [{"max_attempts": v} for v in (True, False, 0, -1, 1.5, "5", math.inf)]
        bad += [{key: v} for key in ("attempt_time_s", "max_time_s")
                for v in (True, 0, -1, "1", math.inf, math.nan)]
        for search in bad:
            with self.subTest(search=search), self.assertRaises(ValueError):
                ik_search.search_options({"search": search})

    def test_initial_seed_success_is_one_attempt_and_does_not_mutate_inputs(self):
        seed = [.1]
        goal = self.model.fk([.4])["pose"]
        before = copy.deepcopy((seed, goal, self.options))
        with patch.object(kinematics, "solve_attempt", wraps=kinematics.solve_attempt) as attempt:
            result = self.model.ik(goal, seed)
        self.assertEqual(attempt.call_count, 1)
        self.assertAlmostEqual(result["joints"][0], .4, places=5)
        self.assertEqual((seed, goal, self.options), before)

    def test_restarts_recover_a_reachable_panda_target(self):
        profile = copy.deepcopy(PANDA)
        profile["intrinsics"]["kinematics"]["ik"]["search"] = {"max_attempts": 1}
        with self.assertRaisesRegex(ValueError, "IK search exhausted"):
            JointDevice(profile).ik(RECOVERY["goal"], RECOVERY["seed"])
        model = JointDevice(PANDA)
        with patch.object(kinematics, "solve_attempt", wraps=kinematics.solve_attempt) as attempt:
            result = model.ik(RECOVERY["goal"], RECOVERY["seed"])
        self.assertEqual(attempt.call_count, 5)
        self.assertEqual(result, model.ik(RECOVERY["goal"], RECOVERY["seed"]))
        error = pose_error(RECOVERY["goal"], model.fk(result["joints"])["pose"])
        self.assertLessEqual(error["position_m"], model.options["position_tolerance_m"])
        self.assertLessEqual(error["rotation_rad"], model.options["rotation_tolerance_rad"])

    def test_fallback_selects_nearest_verified_candidate_with_stable_ties(self):
        attempt = Mock(side_effect=[None, [.8], [-.3], [.3], [.1]])
        verify = Mock(side_effect=[True, True, True, False])
        result = ik_search.search(self.joints, self.options, [], [0], attempt, verify)
        self.assertEqual(result, {"joints": [-.3]})
        self.assertEqual(attempt.call_count, 5)
        self.assertEqual(verify.call_count, 4)

    def test_candidates_are_scaled_by_joint_range_and_only_continuous_joints_wrap(self):
        rotary = {"type": "revolute", "limits": {"min": -3, "max": 3}}
        continuous = {"type": "continuous", "limits": None}
        linear = {"type": "prismatic", "limits": {"min": 0, "max": .1}}
        self.assertGreater(ik_search.distance([rotary], [-2.9], [2.9]), .9)
        self.assertLess(ik_search.distance([continuous], [-2.9], [2.9]), .01)
        self.assertLess(ik_search.distance([rotary, linear], [.6, 0], [0, 0]),
                        ik_search.distance([rotary, linear], [0, .02], [0, 0]))
        q = ik_search.nearest_representation([continuous, rotary], [4*math.pi+.2, -2.9], [0, 2.9])
        self.assertAlmostEqual(q[0], .2)
        self.assertEqual(q[1], -2.9)

    def test_seed_order_is_repeatable_bounded_and_does_not_use_global_rng(self):
        joints = [*self.joints, {"type": "continuous", "limits": None},
                  {"type": "prismatic", "limits": {"min": 0, "max": .1}}]
        original = [1, 20, 0]
        state = random.getstate()
        values = list(ik_search.seeds(joints, [[1, 2, 3]], original, 5))
        self.assertEqual(values, list(ik_search.seeds(joints, [[1, 2, 3]], original, 5)))
        self.assertEqual(random.getstate(), state)
        self.assertEqual(values[0], original)
        for index, q in enumerate(values):
            self.assertTrue(-1 <= q[0] <= 1)
            self.assertTrue(0 <= q[2] <= .1)
            self.assertLessEqual(abs(q[1]-20), .35 if index <= 2 else math.pi)
            if index <= 2:
                self.assertLessEqual(q[2], .005)
        self.assertNotEqual(values[1:], list(ik_search.seeds(joints, [[3, 2, 1]], original, 5))[1:])

    def test_total_deadline_clips_attempts_and_keeps_a_valid_fallback(self):
        now, deadlines = [0.0], []

        def attempt(seed, deadline, progress):
            deadlines.append(deadline)
            now[0] += .02
            return None if len(deadlines) == 1 else [.4]

        with patch.object(ik_search, "monotonic", side_effect=lambda: now[0]):
            result = ik_search.search(self.joints, {**self.options, "search": {"max_time_s": .03}},
                                      [], [0], attempt, lambda q: True)
        self.assertEqual(deadlines, [.02, .03])
        self.assertEqual(result, {"joints": [.4]})

    def test_deadline_is_checked_between_dls_iterations(self):
        solver = self.model.solver
        goal = self.model.fk([.9])["pose"]
        progress = ik_search.Progress()
        with patch.object(ik_search, "monotonic", side_effect=[0, .03]):
            result = kinematics.solve_attempt(self.joints, self.options,
                [(solver, [0], goal[:3], goal[3:])], [0], .02, progress)
        self.assertIsNone(result)
        self.assertEqual(progress.iterations, 1)

    def test_cancellation_interrupts_iterations_and_discards_candidates(self):
        event = threading.Event()
        forward = self.model.solver.forward

        def sample(q):
            event.set()
            return forward(q)

        goal = self.model.fk([.9])["pose"]
        with patch.object(driver_protocol._operation, "cancel", event, create=True), patch.object(
                self.model.solver, "forward", side_effect=sample) as calls:
            with self.assertRaises(InterruptedError):
                self.model.ik(goal, [0])
            self.assertEqual(calls.call_count, 1)
        event.clear()

        def attempt(*_):
            event.set()
            return [.2]

        with patch.object(driver_protocol._operation, "cancel", event, create=True):
            with self.assertRaises(InterruptedError):
                ik_search.search(self.joints, self.options, [], [0], attempt, lambda q: True)
        event.clear()

        def verify(q):
            event.set()
            return True

        with patch.object(driver_protocol._operation, "cancel", event, create=True):
            with self.assertRaises(InterruptedError):
                ik_search.search(self.joints, self.options, [], [0], lambda *_: [.2], verify)

    def test_invalid_inputs_do_not_start_search_and_failures_report_residuals(self):
        with patch.object(kinematics, "solve_attempt") as attempt:
            for goal, seed in [([0]*7, [0]), ([0, 0, 0, 0, 0, 0, 1], [2]),
                               ([math.nan, 0, 0, 0, 0, 0, 1], [0])]:
                with self.assertRaises(ValueError):
                    self.model.ik(goal, seed)
            for key, value in [("max_iterations", True), ("damping", 0), ("search", None)]:
                with patch.dict(self.options, {key: value}), self.assertRaises(ValueError):
                    self.model.ik(self.model.fk([.2])["pose"], [0])
            attempt.assert_not_called()
        with patch.dict(self.options, {"max_iterations": 2, "search": {"max_attempts": 2}}):
            with self.assertRaisesRegex(ValueError, "seeds_attempted=2, iterations=4.*position_error_m=.*rotation_error_rad="):
                self.model.ik([2, 0, 0, 0, 0, 0, 1], [0])

    def test_continuous_and_prismatic_ik_and_native_backend(self):
        profile = simple_profile()
        joint = profile["intrinsics"]["model"]["joints"][0]
        joint.update(type="continuous", limits=None)
        model = JointDevice(profile)
        result = model.ik(model.fk([.2])["pose"], [10*math.pi])
        self.assertAlmostEqual(result["joints"][0], 10*math.pi+.2, places=5)
        joint.update(type="prismatic", limits={"min": 0, "max": 1})
        model = JointDevice(profile)
        self.assertAlmostEqual(model.ik(model.fk([.8])["pose"], [.1])["joints"][0], .8, places=5)
        model.options["backend"] = "driver"
        model.options["frame_to_solver"] = [0, 0, 0, 0, 0, 0, 1]
        model.native_ik = Mock(return_value=[.8])
        with patch.object(kinematics, "search") as search:
            model.ik(model.fk([.8])["pose"], [.1])
            search.assert_not_called()
        model.native_ik.assert_called_once()


class ControllerTests(unittest.TestCase):
    def setUp(self):
        self.profile = copy.deepcopy(PANDA)
        self.profile["resolved_model"] = {key: self.profile["intrinsics"]["model"][key] for key in ("joints", "chain")}
        self.model = JointDevice(self.profile)
        self.positions = list(RECOVERY["seed"])
        self.actions = []
        self.writes, self.ik_calls = [], []
        self.pending = {"existing": True}
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(ik_search, "monotonic", return_value=0))
        for module in ("kinex", "kinex.control", "kinex.frames", "kinex.policy"):
            self.stack.enter_context(patch(f"{module}.device", self.device))
        for module in ("kinex", "kinex.frames"):
            self.stack.enter_context(patch(f"{module}.profile", self.facts))
        self.stack.enter_context(patch("kinex.devices", self.devices))

    def facts(self, name, **_):
        if name == "policy":
            return {"type": "model", "intrinsics": {"operations": [{"name": "infer"}]}}
        return {**self.profile, "name": name}

    def device(self, name, action="read", **args):
        if action == "infer":
            return {"data": {"actions": self.actions}}
        if action == "read":
            return {"data": {"positions": self.positions, "faults": [], "timestamp": 0}}
        if action == "ik":
            seed = args.get("seed", self.model.project(self.positions))
            result = self.model.ik(args["pose"], seed)
            self.ik_calls.append((list(seed), result["joints"]))
            return {"data": result}
        if action == "write":
            self.model.command(args)
            self.writes.append((name, args))
            self.pending = args
            return {"data": {"execution_id": "recovered"}}
        raise AssertionError(f"unexpected device action {action}")

    def devices(self, commands):
        return [{"ok": True, **self.device(c["device"], c["action"], **c["args"])} for c in commands]

    def tool(self, name):
        path = Path(__file__).parent.parent / "assets" / "builtin" / "tool" / name / "tool.py"
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.control

    def test_servo_recovers_through_shared_numerical_ik_before_writing(self):
        result = self.tool("servo")({"device": "arm", "pose": RECOVERY["goal"]})
        self.assertEqual(result["execution_id"], "recovered")
        self.assertEqual(len(self.writes), 1)
        self.assertEqual(result["joints"], self.ik_calls[0][1])
        self.assertEqual(result["actions_submitted"], len(self.pending["actions"]))
        self.assertEqual(self.pending["actions"][-1], result["joints"])

    def test_policy_recovers_seeds_from_predecessor_and_truncates_all_buffers(self):
        goal = RECOVERY["goal"]
        bad = [10, *goal[1:]]
        self.actions = [{"arm": p, "other": self.positions} for p in (goal, goal, bad)]
        result = self.tool("run-policy")({"model": "policy", "observation": {}, "action_hz": 20,
            "command": [{"device": "arm", "space": "pose"}, {"device": "other"}]})
        self.assertEqual(result["actions_submitted"], 2)
        self.assertEqual(result["duration_s"], .1)
        self.assertEqual(result["ik_failure"]["action_index"], 2)
        self.assertIn("IK search exhausted", result["ik_failure"]["error"])
        self.assertEqual(self.ik_calls[0][0], self.positions)
        self.assertEqual(self.ik_calls[1][0], self.ik_calls[0][1])
        self.assertEqual(len(self.writes), 2)
        self.assertTrue(all(len(args["actions"]) == 2 for _, args in self.writes))

    def test_empty_prefix_preserves_existing_motion_and_servo_failure_does_not_write(self):
        bad = [10, *RECOVERY["goal"][1:]]
        self.actions = [bad]
        result = self.tool("run-policy")({"model": "policy", "observation": {},
                                         "command": [{"device": "arm", "space": "pose"}]})
        self.assertEqual(result["actions_submitted"], 0)
        self.assertEqual(result["execution_ids"], {})
        with self.assertRaisesRegex(ValueError, "IK search exhausted"):
            self.tool("servo")({"device": "arm", "pose": bad})
        self.assertEqual(self.writes, [])
        self.assertEqual(self.pending, {"existing": True})


if __name__ == "__main__":
    unittest.main()

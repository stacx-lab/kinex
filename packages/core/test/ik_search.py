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
from kinex.geometry import apply_rt, xyzq_to_rt
from kinex.motion import pose_error
from joint_frames import profile as simple_profile


FIXTURES = Path(__file__).parent / "fixtures" / "ik"
PANDA = json.loads((FIXTURES / "panda.json").read_text())
CORPUS = json.loads((FIXTURES / "corpus.json").read_text())
RECOVERY = next(case for case in CORPUS["cases"] if case["id"] == "medium52")


class SearchTests(unittest.TestCase):
    def setUp(self):
        self.model = JointDevice(simple_profile())
        self.joints = self.model.joints
        self.options = self.model.options
        self.clock = patch.object(ik_search, "monotonic", return_value=0)
        self.clock.start()
        self.addCleanup(self.clock.stop)

    def test_defaults_and_raw_python_validation(self):
        self.assertEqual(ik_search.budget_options({}),
                         {"max_attempts": 5, "attempt_time_s": .02, "max_time_s": .1})
        self.assertEqual(ik_search.budget_options({"budget": {"max_attempts": 1}})["attempt_time_s"], .02)
        bad = [None, [], {"unknown": 1}]
        bad += [{"max_attempts": v} for v in (True, False, 0, -1, 1.5, "5", math.inf)]
        bad += [{key: v} for key in ("attempt_time_s", "max_time_s")
                for v in (True, 0, -1, "1", math.inf, math.nan)]
        for search in bad:
            with self.subTest(search=search), self.assertRaises(ValueError):
                ik_search.budget_options({"budget": search})

    def test_profile_budget_defaults_without_mutation(self):
        options = {"budget": {"max_attempts": 2, "attempt_time_s": .03}}
        before = copy.deepcopy(options)
        self.assertEqual(ik_search.budget_options(options),
                         {"max_attempts": 2, "attempt_time_s": .03, "max_time_s": .1})
        self.assertEqual(options, before)
        with self.assertRaisesRegex(ValueError, "renamed to budget"):
            ik_search.budget_options({"search": {}, "budget": {}})

    def test_driver_request_defaults_and_wire_validation(self):
        from kinex.joint_driver import Driver

        class TestDriver(Driver):
            def model(driver):
                return self.model

            def execute(driver, action, args):
                if action == "read":
                    return {"positions": read()}
                return super().execute(action, args)

        driver = TestDriver.__new__(TestDriver)
        read = Mock(return_value=[1.01])
        target = self.model.fk([.3])["pose"]
        result = driver.execute("ik", {"pose": target, "seed": [0]})
        self.assertAlmostEqual(result["joints"][0], .3, places=5)
        read.assert_not_called()
        with patch.object(self.model, "ik", wraps=self.model.ik) as solve:
            driver.execute("ik", {"pose": target})
            self.assertEqual(solve.call_args.args[1], [1])
        read.assert_called_once()
        read.reset_mock()
        for extra in ({"budget": {}}, {"search": {}}, {"reference_joints": [0]}):
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                driver.execute("ik", {"pose": target, **extra})
        read.assert_not_called()

    def test_python_profile_rejects_legacy_search(self):
        profile = simple_profile()
        profile["intrinsics"]["kinematics"]["ik"]["search"] = {}
        with self.assertRaisesRegex(ValueError, "renamed to budget"):
            JointDevice(profile)

    def test_initial_seed_success_still_compares_candidates_without_mutating_inputs(self):
        seed = [.1]
        goal = self.model.fk([.4])["pose"]
        before = copy.deepcopy((seed, goal, self.options))
        with patch.object(kinematics, "solve_attempt", wraps=kinematics.solve_attempt) as attempt:
            result = self.model.ik(goal, seed)
        self.assertEqual(attempt.call_count, 5)
        self.assertAlmostEqual(result["joints"][0], .4, places=5)
        self.assertEqual((seed, goal, self.options), before)

    def test_restarts_recover_a_reachable_panda_target(self):
        profile = copy.deepcopy(PANDA)
        profile["intrinsics"]["kinematics"]["ik"]["budget"] = {"max_attempts": 1}
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

    def test_target_requiring_global_recovery_is_rejected(self):
        case = next(case for case in CORPUS["cases"] if case["id"] == "medium34")
        with self.assertRaisesRegex(ValueError, "IK search exhausted"):
            JointDevice(PANDA).ik(case["goal"], case["seed"])

    def test_fallback_selects_nearest_verified_candidate_with_stable_ties(self):
        attempt = Mock(side_effect=[None, [.8], [-.3], [.3], [.1]])
        verify = Mock(side_effect=[True, True, True, False])
        result = ik_search.search(self.joints, self.options, [], [0], attempt, verify)
        self.assertEqual(result, {"joints": [-.3]})
        self.assertEqual(attempt.call_count, 5)
        self.assertEqual(verify.call_count, 4)

    def test_first_success_is_not_preferred_over_a_nearer_normalized_candidate(self):
        joints = [{"name": "j", "type": "revolute", "limits": {"min": -10, "max": 10}}]
        attempt = Mock(side_effect=[[2], [math.tau + .2], [-.8], None, None])
        verify = Mock(return_value=True)
        result = ik_search.search(joints, self.options, [], [0], attempt, verify)
        self.assertAlmostEqual(result["joints"][0], .2)
        self.assertAlmostEqual(verify.call_args_list[1].args[0][0], .2)

    def test_zero_displacement_ends_search(self):
        attempt = Mock(return_value=[0])
        self.assertEqual(ik_search.search(self.joints, self.options, [], [0], attempt, lambda q: True),
                         {"joints": [0]})
        attempt.assert_called_once()

    def test_candidates_are_scaled_by_joint_range_and_wrapping_respects_bounds(self):
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

    def test_bounded_equivalence_preserves_limits_and_prismatic_coordinates(self):
        rotary = {"type": "revolute", "limits": {"min": -10, "max": 10}}
        linear = {"type": "prismatic", "limits": {"min": -10, "max": 10}}
        q = ik_search.nearest_representation([rotary, linear], [math.tau + .2]*2, [0, 0])
        self.assertAlmostEqual(q[0], .2)
        self.assertEqual(q[1], math.tau + .2)
        # The unconstrained nearest angle lies outside this one-sided range.
        rotary["limits"] = {"min": 0, "max": 7}
        q = ik_search.nearest_representation([rotary], [6], [0])[0]
        self.assertEqual(q, 6)
        for target, seed in [(0, 7), (7, 0)]:
            q = ik_search.nearest_representation([rotary], [target], [seed])[0]
            self.assertTrue(0 <= q <= 7)
            self.assertAlmostEqual(math.cos(q), math.cos(target))

    def test_native_ik_normalizes_before_independent_fk_verification(self):
        profile = simple_profile()
        profile["intrinsics"]["model"]["joints"][0]["limits"] = {"min": -10, "max": 10}
        profile["intrinsics"]["kinematics"]["ik"].update(
            backend="driver", frame_to_solver=[0, 0, 0, 0, 0, 0, 1])
        model = JointDevice(profile, native_ik=Mock(return_value=[math.tau + .2]))
        target = model.fk([.2])["pose"]
        self.assertAlmostEqual(model.ik(target, [0])["joints"][0], .2)
        model.native_ik.return_value = [math.tau + .8]
        with self.assertRaisesRegex(ValueError, "FK residual verification"):
            model.ik(target, [0])
        model.native_ik.return_value = [20]
        with self.assertRaisesRegex(ValueError, "joint limits"):
            model.ik(target, [0])

    def test_seed_order_is_repeatable_bounded_and_does_not_use_global_rng(self):
        joints = [*self.joints, {"type": "continuous", "limits": None},
                  {"type": "prismatic", "limits": {"min": 0, "max": .1}}]
        original = [1, 20, 0]
        state = random.getstate()
        for count in (1, 5, 20):
            values = list(ik_search.seeds(joints, [[1, 2, 3]], original, count))
            self.assertEqual(len(values), count)
            self.assertEqual(values, list(ik_search.seeds(joints, [[1, 2, 3]], original, count)))
            self.assertEqual(random.getstate(), state)
            self.assertEqual(values[0], original)
            for q in values:
                self.assertTrue(.65 <= q[0] <= 1)
                self.assertLessEqual(abs(q[1]-20), .35 + 1e-12)
                self.assertTrue(0 <= q[2] <= .005 + 1e-12)
        self.assertNotEqual(values[1:], list(ik_search.seeds(joints, [[3, 2, 1]], original, 20))[1:])

    def test_total_deadline_clips_attempts_and_keeps_a_valid_fallback(self):
        now, deadlines = [0.0], []

        def attempt(seed, deadline, progress):
            deadlines.append(deadline)
            now[0] += .02
            return None if len(deadlines) == 1 else [.4]

        with patch.object(ik_search, "monotonic", side_effect=lambda: now[0]):
            result = ik_search.search(self.joints, {**self.options, "budget": {"max_time_s": .03}},
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
            for key, value in [("max_iterations", True), ("damping", 0), ("budget", None)]:
                with patch.dict(self.options, {key: value}), self.assertRaises(ValueError):
                    self.model.ik(self.model.fk([.2])["pose"], [0])
            attempt.assert_not_called()
        with patch.dict(self.options, {"max_iterations": 2, "budget": {"max_attempts": 2}}):
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

    def device(self, deviceID, action="read", args=None):
        args = {} if args is None else args
        if action == "infer":
            return {"actions": self.actions}
        if action == "read":
            return {"positions": self.positions, "faults": [], "timestamp": 0}
        if action == "ik":
            seed = args.get("seed", self.model.project(self.positions))
            result = self.model.ik(args["pose"], seed)
            self.ik_calls.append((list(seed), result["joints"]))
            return result
        if action == "write":
            self.model.command(args)
            self.writes.append((deviceID, args))
            self.pending = args
            return {"execution_id": "recovered"}
        raise AssertionError(f"unexpected device action {action}")

    def devices(self, calls):
        return {"results": [{"deviceID": c["deviceID"], "action": c["action"], "ok": True,
                             "data": self.device(**c)} for c in calls]}

    def tool(self, name):
        path = Path(__file__).parent.parent / "assets" / "builtin" / "tool" / name / "tool.py"
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.control

    def test_servo_recovers_through_shared_numerical_ik_before_writing(self):
        result = self.tool("servo")({"device": "arm", "block": False, "pose": RECOVERY["goal"]})
        self.assertEqual(result["execution_id"], "recovered")
        self.assertEqual(len(self.writes), 1)
        self.assertEqual(result["joints"], self.ik_calls[0][1])
        self.assertEqual(result["actions_submitted"], len(self.pending["actions"]))
        self.assertEqual(self.pending["actions"][-1], result["joints"])

    def test_removed_servo_controls_fail_without_replacing_motion(self):
        servo = self.tool("servo")
        for extra in ({"max_joint_delta": 1}, {"max_joint_delta": None}, {"ik": {}}, {"duration_s": 1}):
            with self.subTest(extra=extra), self.assertRaisesRegex(ValueError, "unsupported servo arguments"):
                servo({"device": "arm", "block": False, "joints": self.positions, **extra})
        self.assertEqual(self.writes, [])
        self.assertEqual(self.pending, {"existing": True})

    def test_cancelled_servo_ik_preserves_existing_motion(self):
        with patch.object(kinematics, "solve_attempt", side_effect=InterruptedError("cancelled")):
            with self.assertRaises(InterruptedError):
                self.tool("servo")({"device": "arm", "block": False, "pose": RECOVERY["goal"]})
        self.assertEqual(self.writes, [])
        self.assertEqual(self.pending, {"existing": True})

    def test_local_servo_rejects_or_avoids_global_branch_detours(self):
        corpus = json.loads((FIXTURES / "servo-local.json").read_text())
        servo = self.tool("servo")
        for case in corpus["cases"]:
            entry = corpus["models"][case["robot"]]
            model = entry["model"]
            for step in (0, .0002, .0003):
                with self.subTest(case=case["id"], clock_step=step):
                    now = 0.0

                    def clock():
                        nonlocal now
                        now += step
                        return now

                    self.profile = {"type": "joint", "resolved_model": model, "intrinsics": {
                        "model": model, "home": None, "frames": {},
                        "control": {"mode": "position", "limit_handling": "native"},
                        "kinematics": {"frame": "tip", "fk": "numerical",
                                       "frame_to_reported": [0, 0, 0, 0, 0, 0, 1], "ik": entry["options"]}}}
                    self.model = JointDevice(self.profile)
                    self.positions = case["start"]
                    self.writes = []
                    self.pending = {"existing": True}
                    with patch.object(ik_search, "monotonic", side_effect=clock):
                        try:
                            result = servo({"device": "arm", "block": False, "pose": case["goal"]})
                        except ValueError as error:
                            self.assertIn("IK search exhausted", str(error))
                            self.assertEqual(self.writes, [])
                            self.assertEqual(self.pending, {"existing": True})
                            continue
                    self.assertEqual(len(self.writes), 1)
                    actions = self.pending["actions"]
                    poses = [self.model.solver.forward(q)[0] for q in [self.positions] + actions]
                    points = [apply_rt(xyzq_to_rt(p), entry["tcp"]) for p in poses]
                    travel = sum(math.dist(a, b) for a, b in zip(points, points[1:]))
                    # ARX deliberately requests a half-turn; Piper/ALOHA preserve orientation.
                    self.assertLess(travel, .25 if case["robot"] == "arx" else .05)
                    if case["robot"] != "arx":
                        self.assertLess(max(pose_error(poses[0], p)["rotation_rad"] for p in poses), .15)
                    error = pose_error(case["goal"], self.model.fk(result["joints"])["pose"])
                    self.assertLessEqual(error["position_m"], entry["options"]["position_tolerance_m"])
                    self.assertLessEqual(error["rotation_rad"], entry["options"]["rotation_tolerance_rad"])

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
            self.tool("servo")({"device": "arm", "block": False, "pose": bad})
        self.assertEqual(self.writes, [])
        self.assertEqual(self.pending, {"existing": True})


if __name__ == "__main__":
    unittest.main()

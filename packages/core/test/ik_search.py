"""Numerical recovery, deadlines and cancellation without device I/O."""

import copy
import json
import math
from pathlib import Path
import random
import threading
import unittest
from unittest.mock import Mock, patch

from kinex import cancellation, ik_search, kinematics
from kinex.joints import JointModel
from kinex.motion import pose_error
from joint_model import model as joint_model, simple


FIXTURES = Path(__file__).parent / "fixtures" / "ik"
PANDA = JointModel(json.loads((FIXTURES / "panda.json").read_text()), FIXTURES)
CORPUS = json.loads((FIXTURES / "corpus.json").read_text())
RECOVERY = next(case for case in CORPUS["cases"] if case["id"] == "medium52")
TIGHT = {"position_tolerance_m": 1e-6, "rotation_tolerance_rad": 1e-6}


class SearchTests(unittest.TestCase):
    def setUp(self):
        self.model = joint_model(simple(), "flange")
        self.joints = self.model.joints
        self.options = {**kinematics.DEFAULTS, **TIGHT}
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

    def test_budget_defaults_without_mutation(self):
        options = {"budget": {"max_attempts": 2, "attempt_time_s": .03}}
        before = copy.deepcopy(options)
        self.assertEqual(ik_search.budget_options(options),
                         {"max_attempts": 2, "attempt_time_s": .03, "max_time_s": .1})
        self.assertEqual(options, before)

    def test_initial_seed_success_still_compares_candidates_without_mutating_inputs(self):
        seed = [.1]
        goal = self.model.fk([.4])
        before = copy.deepcopy((seed, goal, self.options))
        with patch.object(kinematics.Chain, "attempt", autospec=True, side_effect=kinematics.Chain.attempt) as attempt:
            result = self.model.ik(goal, seed, **TIGHT)
        self.assertEqual(attempt.call_count, 5)
        self.assertAlmostEqual(result[0], .4, places=5)
        self.assertEqual((seed, goal, self.options), before)

    def test_restarts_recover_a_reachable_panda_target(self):
        with self.assertRaisesRegex(ValueError, "IK search exhausted"):
            PANDA.ik(RECOVERY["goal"], RECOVERY["seed"], budget={"max_attempts": 1})
        with patch.object(kinematics.Chain, "attempt", autospec=True, side_effect=kinematics.Chain.attempt) as attempt:
            result = PANDA.ik(RECOVERY["goal"], RECOVERY["seed"])
        self.assertEqual(attempt.call_count, 5)
        self.assertEqual(result, PANDA.ik(RECOVERY["goal"], RECOVERY["seed"]))
        error = pose_error(RECOVERY["goal"], PANDA.fk(result))
        self.assertLessEqual(error["position_m"], kinematics.DEFAULTS["position_tolerance_m"])
        self.assertLessEqual(error["rotation_rad"], kinematics.DEFAULTS["rotation_tolerance_rad"])

    def test_target_requiring_global_recovery_is_rejected(self):
        case = next(case for case in CORPUS["cases"] if case["id"] == "medium34")
        with self.assertRaisesRegex(ValueError, "IK search exhausted"):
            PANDA.ik(case["goal"], case["seed"])

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
        goal = self.model.fk([.9])
        progress = ik_search.Progress()
        with patch.object(ik_search, "monotonic", side_effect=[0, .03]):
            result = self.model.chain(None).attempt(goal, self.options, [0], .02, progress)
        self.assertIsNone(result)
        self.assertEqual(progress.iterations, 1)

    def test_cancellation_interrupts_iterations_and_discards_candidates(self):
        event = threading.Event()
        forward = kinematics.Chain.forward

        def sample(chain, q):
            event.set()
            return forward(chain, q)

        goal = self.model.fk([.9])
        with patch.object(cancellation._operation, "cancel", event, create=True), patch.object(
                kinematics.Chain, "forward", autospec=True, side_effect=sample) as calls:
            with self.assertRaises(InterruptedError):
                self.model.ik(goal, [0])
            self.assertEqual(calls.call_count, 1)
        event.clear()

        def attempt(*_):
            event.set()
            return [.2]

        with patch.object(cancellation._operation, "cancel", event, create=True):
            with self.assertRaises(InterruptedError):
                ik_search.search(self.joints, self.options, [], [0], attempt, lambda q: True)
        event.clear()

        def verify(q):
            event.set()
            return True

        with patch.object(cancellation._operation, "cancel", event, create=True):
            with self.assertRaises(InterruptedError):
                ik_search.search(self.joints, self.options, [], [0], lambda *_: [.2], verify)

    def test_invalid_inputs_do_not_start_search_and_failures_report_residuals(self):
        with patch.object(kinematics.Chain, "attempt") as attempt:
            for goal in ([0]*7, [math.nan, 0, 0, 0, 0, 0, 1]):
                with self.assertRaises(ValueError):
                    self.model.ik(goal, [0])
            for key, value in [("max_iterations", True), ("damping", 0), ("budget", None)]:
                with self.assertRaises(ValueError):
                    self.model.ik(self.model.fk([.2]), [0], **{key: value})
            attempt.assert_not_called()
        with self.assertRaisesRegex(ValueError, "seeds_attempted=2, iterations=4.*position_error_m=.*rotation_error_rad="):
            self.model.ik([2, 0, 0, 0, 0, 0, 1], [0], max_iterations=2, budget={"max_attempts": 2})

    def test_seeds_outside_limits_are_projected(self):
        self.assertAlmostEqual(self.model.ik(self.model.fk([.9]), [2], **TIGHT)[0], .9, places=5)



if __name__ == "__main__":
    unittest.main()

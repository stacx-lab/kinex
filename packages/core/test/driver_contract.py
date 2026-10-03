"""Core scalar validation and hardware buffers."""

import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from kinex.buffer import Buffer
from kinex.scalar_control import command
from kinex.joint_driver import Driver as JointDriver
from kinex.velocity_driver import Driver as VelocityDriver


class ScalarTests(unittest.TestCase):
    def test_flat_sequences_validate_all_values_and_apply_profile_semantics(self):
        for control, values, expected in (
            ({"mode": "position", "bounds": {"min": 0, "max": 1}, "resolution": .1, "speed": None}, [.24, .76], [.2, .8]),
            ({"mode": "direction"}, [.3, 0, -.2], [1, 0, -1]),
            ({"mode": "binary", "off_target": 2, "on_target": 5}, [2, 5], [2, 5]),
        ):
            profile = {"intrinsics": {"control": control}}
            self.assertEqual(command(profile, {"actions": values, "duration_s": .5}),
                             {"actions": expected, "duration_s": .5})
            for args in ({"target": [values[0]]}, {"actions": [[values[0]]]}, {"actions": []},
                         {"actions": [True]}, {"actions": [float("nan")]},
                         {"actions": [values[0], 9]}, {"actions": values, "speedFraction": .5}):
                with self.assertRaises(ValueError):
                    command(profile, {**args, "duration_s": .5})
            for duration in (0, -1, True, float("inf")):
                with self.assertRaises(ValueError):
                    command(profile, {"actions": values, "duration_s": duration})



class BufferTests(unittest.TestCase):
    def test_late_failure_does_not_cancel_replacement(self):
        stopped = []
        buffer = Buffer(.005, lambda value: None, lambda: stopped.append(True))
        try:
            old = buffer.submit([1], 10)
            replacement = buffer.submit([2], 10)
            with self.assertRaisesRegex(ValueError, "bad feedback"):
                buffer.result(old, lambda: self.fail_read())
            self.assertEqual(buffer.owner, replacement)
            self.assertIsNotNone(buffer.pending)
            self.assertEqual(stopped, [])
        finally:
            buffer.close()

    @staticmethod
    def fail_read():
        raise ValueError("bad feedback")

    def test_failed_feedback_cancels_retained_position(self):
        stopped = []
        buffer = Buffer(.005, lambda value: None, lambda: stopped.append(True))
        try:
            identity = buffer.submit([1], .01)
            deadline = time.monotonic() + 1
            with buffer.condition:
                while buffer.pending is not None:
                    self.assertLess(time.monotonic(), deadline)
                    buffer.condition.wait(.01)
            with self.assertRaisesRegex(ValueError, "bad feedback"):
                buffer.result(identity, self.fail_read)
            self.assertEqual(stopped, [True])
            self.assertIsNone(buffer.owner)
        finally:
            buffer.close()

    def test_replacement_and_expiry_preserve_position_target(self):
        applied, stopped = [], []
        ready = threading.Event()

        def apply(value):
            applied.append(value)
            ready.set()

        buffer = Buffer(.005, apply, lambda: stopped.append(True))
        try:
            buffer.submit([1, 2], 1)
            self.assertTrue(ready.wait(1))
            buffer.submit([3, 4], .03)
            deadline = time.monotonic() + 1
            with buffer.condition:
                while buffer.pending is not None:
                    self.assertLess(time.monotonic(), deadline)
                    buffer.condition.wait(.01)
            self.assertEqual(applied[-1], 4)
            self.assertEqual(stopped, [])
            buffer.stop()
            self.assertEqual(stopped, [True])
        finally:
            buffer.close()

    def test_submission_returns_before_velocity_expiry(self):
        applied, stopped = [], threading.Event()
        buffer = Buffer(.005, applied.append, stopped.set, expire=True)
        try:
            self.assertTrue(buffer.submit([1], .1))
            self.assertIsNotNone(buffer.pending)
            self.assertFalse(stopped.is_set())
            self.assertTrue(stopped.wait(1))
            self.assertEqual(applied[-1], 1)
        finally:
            buffer.close()

    def test_native_error_latches_and_halts(self):
        stopped = threading.Event()

        def apply(value):
            raise RuntimeError("motor offline")

        buffer = Buffer(.005, apply, stopped.set)
        try:
            buffer.submit([1], .1)
            self.assertTrue(stopped.wait(1))
            with self.assertRaisesRegex(RuntimeError, "motor offline"):
                buffer.submit([2], .1)
        finally:
            buffer.close()


class DriverCleanupTests(unittest.TestCase):
    def driver(self, kind, *, stop_fails=False):
        profile = {"type": "velocity", "intrinsics": {"stop": {}}}
        base = VelocityDriver if kind == "velocity" else JointDriver
        hardware = type("Hardware", (base,), {"period_s": .005})
        with patch(f"kinex.{kind}_driver.settings", return_value=profile):
            driver = hardware("unused")
        driver.serving = True
        driver.connect = lambda: object()
        driver.disconnect = lambda handle: None
        applied = threading.Event()
        driver.set_target = lambda *args: applied.set()
        driver.stops = []

        def halt(*args):
            driver.stops.append(args)
            if stop_fails:
                raise RuntimeError("stop offline")

        def read(handle):
            self.assertTrue(applied.wait(1))
            raise ValueError("malformed feedback")

        driver.halt = halt
        driver.read_state = read
        value = {"actions": [1], "duration_s": 10}
        if kind == "velocity":
            driver.command = lambda args: value
        else:
            driver._model = SimpleNamespace(command=lambda args: value, reading=lambda state: state)
        return driver

    def test_drivers_stop_accepted_write_before_reporting_bad_feedback(self):
        for kind in ("velocity", "joint"):
            with self.subTest(kind=kind):
                driver = self.driver(kind)
                try:
                    result = driver.dispatch("write", {})
                    self.assertFalse(result["ok"])
                    self.assertIn("malformed feedback", result["error"])
                    self.assertEqual(len(driver.stops), 1)
                    self.assertIsNone(driver.buffer.pending)
                    self.assertIsNone(driver.buffer.owner)
                finally:
                    driver.close(stop=False)

    def test_cleanup_failure_is_structured_and_blocks_future_submission(self):
        for kind in ("velocity", "joint"):
            with self.subTest(kind=kind):
                driver = self.driver(kind, stop_fails=True)
                try:
                    result = driver.dispatch("write", {})
                    self.assertEqual(result["code"], "stop_failed")
                    self.assertEqual(result["details"]["effects"], "unknown")
                    self.assertIn("malformed feedback", result["details"]["validation_error"])
                    owner = driver.buffer.owner
                    self.assertFalse(driver.dispatch("write", {})["ok"])
                    self.assertEqual(driver.buffer.owner, owner)
                    self.assertEqual(len(driver.stops), 1)
                finally:
                    driver.close(stop=False)

    def test_rejected_submission_does_not_change_stop_target(self):
        driver = self.driver("velocity")
        driver.buffer = Buffer(.005, lambda value: None, lambda: None)
        driver.target = {"previous": True}
        driver.buffer.error = "existing fault"
        try:
            self.assertFalse(driver.dispatch("write", {})["ok"])
            self.assertEqual(driver.target, {"previous": True})
        finally:
            driver.close(stop=False)



if __name__ == "__main__":
    unittest.main()

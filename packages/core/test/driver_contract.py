"""Core scalar validation and hardware buffers."""

import threading
import time
import unittest

from kinex.buffer import Buffer
from kinex.scalar_control import command


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



if __name__ == "__main__":
    unittest.main()

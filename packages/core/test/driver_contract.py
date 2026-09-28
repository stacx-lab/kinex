"""Hardware buffers and per-request world-clock cancellation."""

import json
import importlib.util
import queue
import subprocess
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

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

    def test_driver_keeps_speed_across_flat_buffer_and_rejects_before_replacement(self):
        path = Path(__file__).parents[1] / "assets/builtin/device/templates/gripper/driver.py"
        spec = importlib.util.spec_from_file_location("gripper_driver", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        profile = {"type": "gripper", "intrinsics": {
            "control": {"mode": "position", "bounds": {"min": 0, "max": 1}, "resolution": None,
                        "speed": {"native_bounds": {"min": 1, "max": 10}, "native_resolution": 1, "default_fraction": .5}},
            "feedback": {"positions": ["finger"], "velocities": False},
            "stop": {"behavior": "hold", "affected_devices": ["gripper"]},
        }}
        class Hardware(module.ScalarDriver):
            @property
            def period_s(self):
                return .005

        with patch("kinex.velocity_driver.settings", return_value=profile):
            driver = Hardware(path.parent)
        applied, stopped = [], []
        driver.serving = True
        driver.connect = lambda: object()
        driver.disconnect = lambda handle: None
        driver.read_state = lambda handle: {"positions": [0], "velocities": [], "faults": [], "sample_time_s": time.monotonic()}
        driver.set_target = lambda handle, value: applied.append(value)
        driver.halt = lambda handle, value: stopped.append(True)
        try:
            result = driver.execute("write", {"actions": [.2, .8], "duration_s": .1, "speedFraction": .3})
            self.assertIsInstance(result["execution_id"], str)
            self.assertGreaterEqual(result["elapsed_s"], 0)
            with driver.buffer.condition:
                pending = driver.buffer.pending
                with self.assertRaises(ValueError):
                    driver.execute("write", {"actions": [.3, 2], "duration_s": .1})
                self.assertIs(driver.buffer.pending, pending)
                deadline = time.monotonic() + 1
                while driver.buffer.pending is not None:
                    self.assertLess(time.monotonic(), deadline)
                    driver.buffer.condition.wait(.01)
            self.assertEqual(applied[-1], {"target": .8, "native_speed": 3})
            self.assertTrue(all(value["native_speed"] == 3 for value in applied))
            self.assertEqual(stopped, [])
            driver.execute("write", {"actions": [.4], "duration_s": .1})
            self.assertEqual(stopped, [])
            driver.execute("stop", {})
            self.assertEqual(stopped, [True])
        finally:
            driver.close(stop=False)


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

    def test_world_waits_overlap_and_cancel_independently(self):
        driver = Path(__file__).parents[1] / "assets/builtin/device/templates/world/driver.py"
        with subprocess.Popen([sys.executable, str(driver), "--serve"], stdin=subprocess.PIPE,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) as process:
            replies = queue.Queue()
            thread = threading.Thread(target=lambda: [replies.put(json.loads(line)) for line in process.stdout], daemon=True)
            thread.start()

            def send(identity, action=None, **values):
                payload = {"id": identity, **values}
                if action:
                    payload.update(action=action)
                process.stdin.write(json.dumps(payload) + "\n")
                process.stdin.flush()

            try:
                send("load", "load")
                self.assertTrue(replies.get(timeout=2)["ok"])
                start = time.monotonic()
                send("long", "wait", args={"duration_s": 5})
                send("short", "wait", args={"duration_s": .1})
                send("cancel", interrupt="long")
                results = {value["id"]: value for value in [replies.get(timeout=2) for _ in range(3)]}
                self.assertFalse(results["long"]["ok"])
                self.assertTrue(results["short"]["ok"])
                self.assertGreaterEqual(results["short"]["elapsed_s"], .1)
                self.assertLess(time.monotonic() - start, 2)
                send("unload", "unload")
                self.assertTrue(replies.get(timeout=2)["ok"])
            finally:
                process.stdin.close()
                process.wait(timeout=2)
                thread.join(timeout=2)
                self.assertEqual(process.returncode, 0, process.stderr.read())


if __name__ == "__main__":
    unittest.main()

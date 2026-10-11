"""Transport and failure-path checks against a scripted, hardware-free ROS graph."""

from concurrent.futures import Future
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from kinex_ros.ros2 import BundleError, Latest, Session, StopConfirm, StopNotConfirmed


class Helpers(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.file = Path(self.directory.name) / "scenario.json"
        self.environment = patch.dict(os.environ, {"KINEX_FAKE_RCLPY_SCENARIO": str(self.file), "ROS_DOMAIN_ID": "7"})
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def session(self, specification=None):
        self.file.write_text(json.dumps(specification or {}))
        session = Session(domain_id=7).open()
        self.addCleanup(session.close)
        return session

    def test_import_is_lazy_without_ros(self):
        root = str(Path(__file__).resolve().parents[1] / "assets/python")
        result = subprocess.run([sys.executable, "-c", "import sys; import kinex_ros.ros2; assert 'rclpy' not in sys.modules"], env={**os.environ, "PYTHONPATH": root + os.pathsep + str(Path(__file__).parents[2] / "core/assets/python")}, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_stop_needs_new_finite_velocity_sample(self):
        cache = Latest("/state")
        cache.update([0.])
        with self.assertRaises(StopNotConfirmed):
            StopConfirm(cache, lambda value: value, .01, .02).wait()
        confirm = StopConfirm(cache, lambda value: value, .01, .2)
        timer = threading.Timer(.01, lambda: cache.update([0.]))
        timer.start()
        confirm.wait()
        timer.join()
        for values in ([float("nan")], [], [True]):
            confirm = StopConfirm(cache, lambda value: value, .01, .1)
            cache.update(values)
            with self.assertRaises(StopNotConfirmed):
                confirm.wait()

    def test_owned_contexts_close_independently_and_idempotently(self):
        first, second = self.session(), self.session()
        context = second.context
        first.close()
        first.close()
        self.assertTrue(context.ok())
        second.check()

    def test_hung_shutdown_is_bounded_and_other_stages_run(self):
        session = self.session()
        node, context, executor = session.node, session.context, session.executor
        gate = threading.Event()
        self.addCleanup(gate.set)
        shutdown = executor.shutdown
        executor.shutdown = lambda timeout_sec: (shutdown(timeout_sec), gate.wait(5))
        start = time.monotonic()
        with self.assertRaises(ExceptionGroup):
            session.close(.2)
        self.assertLess(time.monotonic() - start, .5)
        self.assertTrue(node.destroyed)
        self.assertFalse(context.ok())

    def test_action_timeout_keeps_a_late_accepted_goal_cancellable(self):
        session = self.session()
        action = session.action("/jtc/follow_joint_trajectory")
        handle = action.client.send_goal_async(action.type.Goal()).result()
        acceptance = Future()
        action.client.send_goal_async = lambda goal: acceptance
        with self.assertRaisesRegex(BundleError, "outcome is unknown"):
            action.send(action.type.Goal(), timeout_s=.01)
        self.assertEqual(action.pending, [acceptance])
        acceptance.set_result(handle)
        action.cancel_all()
        self.assertEqual(action.handles, [])
        self.assertEqual(session.context.world.published[-1][1], {"cancel": True})


if __name__ == "__main__":
    unittest.main()

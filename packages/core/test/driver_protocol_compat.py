"""Shared driver helpers must behave the same on Python 3.10 and newer."""

import unittest

from kinex.driver_protocol import CleanupError, release


class CompatibilityTests(unittest.TestCase):
    def test_release_runs_every_stage_and_reports_all_failures(self):
        calls = []

        def failing(name):
            def stage():
                calls.append(name)
                raise RuntimeError(name)
            return stage

        with self.assertRaises(CleanupError) as caught:
            release(failing("first"), lambda: calls.append("ok"), failing("second"))
        self.assertEqual(calls, ["first", "ok", "second"])
        self.assertEqual([str(error) for error in caught.exception.errors], ["first", "second"])
        self.assertEqual(caught.exception.code, "cleanup_failed")
        self.assertIn("first; second", str(caught.exception))
        self.assertIsInstance(caught.exception, RuntimeError)
        self.assertIsNone(release(lambda: None))


if __name__ == "__main__":
    unittest.main()

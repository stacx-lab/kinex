"""Representative checker evidence, failure status and camera profile repair."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from kinex_ros.ros2 import ROSError, Session
from kinex_ros.config import read_yaml
from kinex_ros.ros2_check import check
from ros2_fixtures import fixture, write


class Checker(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        environment = patch.dict(os.environ, {"KINEX_FAKE_RCLPY_SCENARIO": str(self.directory / "scenario.json"), "ROS_DOMAIN_ID": "0"})
        environment.start()
        self.addCleanup(environment.stop)
        self.manifest, self.profile, self.graph = fixture(self.directory)
        self.output = self.directory / "verify/measurements.json"

    def save(self):
        write(self.directory / "profile_ros.yaml", self.manifest)
        (self.directory / "scenario.json").write_text(json.dumps(self.graph))

    def test_document_has_independent_evidence_and_numeric_units(self):
        document, failures = check(self.directory, duration_s=.04)
        self.assertFalse(failures)
        self.assertFalse(self.output.exists())
        self.assertEqual(set(document["required_checks"]), {entry["name"] for entry in document["checks"]})
        for entry in document["checks"]:
            self.assertTrue(entry["reference"])
            self.assertNotIn("passed", entry)
            if type(entry["expected"]) in (int, float):
                self.assertGreaterEqual(entry["tolerance"], 0)
                self.assertTrue(entry["units"])
        rate = next(item for item in document["checks"] if item["name"].startswith("rate:"))
        self.assertEqual(rate["expected"], 0)
        self.assertEqual(rate["measured"], 0)
        self.assertLess(rate["timestamps"][0], rate["timestamps"][1])
        self.assertIn("Declared behavior only", document["information"]["driver_loss_note"])

    def test_cli_returns_checks_without_creating_verify_directory(self):
        result = subprocess.run([sys.executable, "-m", "kinex_ros.ros2_check", "--dir", str(self.directory), "--duration-s", ".04"],
                                capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        document = json.loads(result.stdout)
        self.assertTrue(document["ok"])
        self.assertTrue(document["checks"])
        self.assertFalse((self.directory / "verify").exists())

    def test_cli_failure_is_bounded_and_exits_one(self):
        self.manifest["expected"]["topics"][0]["min_hz"] = 10000
        self.save()
        result = subprocess.run([sys.executable, "-m", "kinex_ros.ros2_check", "--dir", str(self.directory), "--duration-s", ".04"],
                                capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("FAIL rate:/joint_states", result.stdout)
        self.assertFalse(json.loads(result.stdout)["ok"])
        self.assertFalse(self.output.exists())
        self.assertLessEqual(len(result.stdout.splitlines()), 20)

    def test_configuration_and_cleanup_errors_do_not_write_reports(self):
        check(self.directory, duration_s=.03)
        (self.directory / "profile_ros.yaml").write_text("domain_id: [bad]\n")
        with self.assertRaises(Exception):
            check(self.directory, duration_s=.03)
        self.assertFalse(self.output.exists())
        self.save()
        close = Session.close
        def fail_close(session):
            close(session)
            raise ROSError("cleanup failed")
        with patch.object(Session, "close", fail_close), self.assertRaisesRegex(ROSError, "cleanup failed"):
            check(self.directory, duration_s=.03)
        self.assertFalse(self.output.exists())

    def test_camera_checks_fail_on_profile_drift_and_pass_after_explicit_repair(self):
        cases = [("rgb", "color", "width", 640), ("rgbd", "depth", "height", 480),
                 ("rgb", "color", "projection", {"model": "pinhole", "fx": 999., "fy": 100., "cx": 1., "cy": .5, "skew": 0.}),
                 ("rgb", "color", "distortion", {"model": "opencv_brown_conrady", "k1": .1}),
                 ("rgb", "color", "width", "???")]
        for kind, channel, field, wrong in cases:
            with self.subTest(kind=kind, channel=channel, field=field, wrong=wrong):
                _, profile, _ = fixture(self.directory, kind)
                profile["intrinsics"][channel][field] = wrong
                write(self.directory / "profile.yaml", profile)
                document, failures = check(self.directory, duration_s=.03, introspect=True)
                name = f"camera:{channel}:{field}"
                self.assertTrue(any(name in failure for failure in failures))
                self.assertIn(name, document["required_checks"])
                self.assertFalse(self.output.exists())
                self.assertEqual(read_yaml(self.directory / "profile.yaml")["intrinsics"][channel][field], wrong)
                self.assertFalse((self.directory / "profile.patch.json").exists())
                observed = document["profile_patch"]
                profile["intrinsics"][channel].update(observed["intrinsics"][channel])
                write(self.directory / "profile.yaml", profile)
                self.assertFalse(check(self.directory, duration_s=.03, introspect=True)[1])


if __name__ == "__main__":
    unittest.main()

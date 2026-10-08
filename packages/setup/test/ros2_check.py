"""Checker evidence, exit status and explicit model capture without ROS."""

import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from kinex_ros.ros2 import BundleError, Session
from kinex_ros.bundle_manifest import read_yaml
from kinex_ros.ros2_check import check, main, validate_checks
from kinex_ros.ros2_drivers import JointTrajectoryDriver
from ros2_fixtures import fixture, write, URDF


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
        write(self.directory / "bundle.yaml", self.manifest)
        (self.directory / "scenario.json").write_text(json.dumps(self.graph))

    def test_document_has_independent_evidence_and_numeric_units(self):
        document, failures = check(self.directory, duration_s=.04)
        self.assertFalse(failures)
        self.assertEqual(document, json.loads(self.output.read_text()))
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

    def test_cli_failure_is_bounded_and_exits_one(self):
        self.manifest["expected"]["topics"][0]["min_hz"] = 10000
        self.save()
        result = subprocess.run([sys.executable, "-m", "kinex_ros.ros2_check", "--dir", str(self.directory), "--duration-s", ".04"],
                                capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("FAIL rate:/joint_states", result.stdout)
        self.assertLessEqual(len(result.stdout.splitlines()), 20)

    def test_save_urdf_records_identity_and_future_drift_fails(self):
        self.manifest["expected"]["robot_description"] = {"compare_to": "model.urdf", "expect_joints": 2}
        self.save()
        with self.assertRaisesRegex(BundleError, "--save-urdf"):
            check(self.directory, duration_s=.03)
        document, failures = check(self.directory, duration_s=.03, save_urdf=True)
        self.assertFalse(failures)
        model = (self.directory / "model.urdf").read_bytes()
        identity = json.loads((self.directory / "identity.json").read_text())
        self.assertEqual(model.decode(), URDF)
        self.assertEqual(identity["robot_description_sha256"], hashlib.sha256(model).hexdigest())
        self.assertEqual(identity["publisher_node"], "/robot")
        self.assertFalse(check(self.directory, duration_s=.03)[1])
        (self.directory / "model.urdf").write_text(URDF.replace("demo", "another"))
        self.assertTrue(any("model_sha256" in failure for failure in check(self.directory, duration_s=.03)[1]))
        self.assertEqual(json.loads((self.directory / "identity.json").read_text()), identity)

    def test_missing_reference_is_rejected_by_runtime_too(self):
        self.manifest["expected"]["robot_description"] = {"compare_to": "missing.urdf"}
        self.save()
        with self.assertRaisesRegex(BundleError, "missing"):
            JointTrajectoryDriver(self.directory)

    def test_configuration_and_cleanup_errors_replace_stale_passing_evidence(self):
        check(self.directory, duration_s=.03)
        (self.directory / "bundle.yaml").write_text("version: [bad]\n")
        with self.assertRaises(Exception):
            check(self.directory, duration_s=.03)
        self.assertFalse(json.loads(self.output.read_text())["checks"][0]["measured"])
        self.save()
        close = Session.close
        def fail_close(session):
            close(session)
            raise BundleError("cleanup failed")
        with patch.object(Session, "close", fail_close), self.assertRaisesRegex(BundleError, "cleanup failed"):
            check(self.directory, duration_s=.03)
        self.assertFalse(json.loads(self.output.read_text())["checks"][0]["measured"])

    def test_invalid_generation_configuration_replaces_device_evidence(self):
        generation = self.directory / "ros/generations/test"
        fixture(generation)
        (generation / "generation.json").write_text(json.dumps({
            "device_directory": str(self.directory), "target_directory": str(generation), "parent_directory": None,
        }))
        check(generation, duration_s=.03)
        self.assertTrue(self.output.is_file())
        (generation / "bundle.yaml").write_text("version: [bad]\n")
        with self.assertRaises(Exception):
            check(generation, duration_s=.03)
        self.assertFalse(json.loads(self.output.read_text())["checks"][0]["measured"])
        self.assertFalse((generation / "verify/measurements.json").exists())

    def test_ready_checks_only_topics_and_does_not_write_evidence(self):
        self.manifest["expected"]["robot_description"] = {"compare_to": "missing.urdf"}
        self.save()
        check(self.directory, ready=True)
        self.assertFalse(self.output.exists())
        self.graph["topics"] = {}
        self.save()
        with self.assertRaisesRegex(BundleError, "missing ROS topics"):
            check(self.directory, ready=True, timeout_s=.01)
        self.assertFalse(self.output.exists())

    def test_recorded_domain_and_publisher_gate(self):
        (self.directory / "identity.json").write_text(json.dumps({"domain_id": 4, "namespace": "/other", "publisher_node": "/different"}))
        _, failures = check(self.directory, duration_s=.03)
        self.assertEqual(sum(any(name in failure for failure in failures) for name in ("recorded_domain", "recorded_namespace", "publisher_identity")), 3)

    def test_parameters_and_bundle_extras_are_assessed(self):
        self.manifest["expected"]["parameters"] = [{"node": "/controller", "name": "timeout", "expected": .2, "tolerance": .01, "units": "s"}]
        self.graph["parameters"] = {"/controller": {"timeout": .3}}
        (self.directory / "check.py").write_text("def checks(session, bundle, facts):\n    return [{'name': 'extra', 'expected': True, 'measured': True, 'reference': 'fixture observation'}]\n")
        self.save()
        document, failures = check(self.directory, duration_s=.03)
        self.assertEqual(len(failures), 1)
        self.assertIn("param:/controller/timeout", failures[0])
        self.assertIn("extra", document["required_checks"])

    def test_domain_alone_is_not_interface_evidence(self):
        self.manifest["expected"] = {"domain": True}
        self.save()
        with self.assertRaisesRegex(BundleError, "no interface checks"):
            check(self.directory, duration_s=.03)

    def test_camera_introspection_emits_partial_profile(self):
        fixture(self.directory, "rgbd")
        _, failures = check(self.directory, duration_s=.03, introspect=True)
        self.assertFalse(failures)
        profile = json.loads((self.directory / "profile.patch.json").read_text())
        self.assertEqual(profile["intrinsics"]["color"]["projection"]["fx"], 100.)
        self.assertEqual(profile["intrinsics"]["method"], "introspection")

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
                self.assertEqual(document, json.loads(self.output.read_text()))
                self.assertEqual(read_yaml(self.directory / "profile.yaml")["intrinsics"][channel][field], wrong)
                observed = json.loads((self.directory / "profile.patch.json").read_text())
                profile["intrinsics"][channel].update(observed["intrinsics"][channel])
                write(self.directory / "profile.yaml", profile)
                self.assertFalse(check(self.directory, duration_s=.03, introspect=True)[1])

    def test_rectified_camera_checker_repairs_from_p_and_rereads_profile(self):
        manifest, profile, graph = fixture(self.directory, "rgb")
        manifest["driver"].update(color_topic="/image_rect_color", color_image_space="rectified")
        manifest["expected"]["topics"][0]["name"] = "/image_rect_color"
        profile["access"]["connection"]["color_topic"] = "/image_rect_color"
        graph["topics"]["/image_rect_color"] = graph["topics"].pop("/color")
        info = graph["topics"]["/info"]["message"]
        info.update(d=[.1, .2, 0., 0., .3], p=[80., 0., 1., 0., 0., 80., .5, 0., 0., 0., 1., 0.])
        write(self.directory / "bundle.yaml", manifest)
        write(self.directory / "profile.yaml", profile)
        (self.directory / "scenario.json").write_text(json.dumps(graph))
        _, failures = check(self.directory, duration_s=.03, introspect=True)
        self.assertEqual(len(failures), 1)
        self.assertIn("camera:color:projection", failures[0])
        observed = json.loads((self.directory / "profile.patch.json").read_text())["intrinsics"]["color"]
        self.assertEqual(observed["projection"]["fx"], 80.)
        self.assertEqual(observed["distortion"], {"model": "none"})
        profile["intrinsics"]["color"].update(observed)
        write(self.directory / "profile.yaml", profile)
        self.assertFalse(check(self.directory, duration_s=.03, introspect=True)[1])
        del manifest["driver"]["color_image_space"]
        write(self.directory / "bundle.yaml", manifest)
        with self.assertRaisesRegex(BundleError, "driver.color_image_space"):
            check(self.directory, duration_s=.03, introspect=True)
        self.assertFalse(json.loads(self.output.read_text())["checks"][0]["measured"])

    def test_camera_cli_reports_profile_mismatch_as_failure(self):
        _, profile, _ = fixture(self.directory, "rgb")
        profile["intrinsics"]["color"]["width"] = 640
        write(self.directory / "profile.yaml", profile)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(main(["--dir", str(self.directory), "--duration-s", ".03", "--introspect"]), 1)
        self.assertIn("FAIL camera:color:width", output.getvalue())

    def test_invalid_extra_evidence_cannot_claim_success(self):
        cases = [[], [{"name": "x", "expected": 1, "measured": 1, "reference": "fixture"}],
                 [{"name": "x", "expected": True, "measured": True, "reference": ""}],
                 [{"name": "x", "expected": True, "measured": True, "reference": "fixture", "timestamps": [2, 1]}]]
        for values in cases:
            with self.subTest(values=values), self.assertRaises(BundleError):
                validate_checks(values)
        entry = {"name": "x", "expected": True, "measured": False, "reference": "fixture", "passed": True}
        self.assertFalse(validate_checks([entry])[0][1])

    def test_success_cli_prints_ok(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(main(["--dir", str(self.directory), "--duration-s", ".03"]), 0)
        self.assertEqual(output.getvalue(), "ok\n")


if __name__ == "__main__":
    unittest.main()

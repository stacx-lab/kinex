"""Representative bundle facts, dependency checks and provisioning recovery."""

import copy
import contextlib
import io
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from shlex import split
from unittest.mock import patch

from kinex_ros import bundle as kb
from kinex_ros import bundle_install

FIXTURE = Path(__file__).parent / "fixtures/bundles/demo-arm"
LIBRARY = Path(__file__).parents[1] / "assets/python"
CORE_LIBRARY = Path(__file__).parents[2] / "core/assets/python"
LIBRARIES = ["--core-library", str(CORE_LIBRARY), "--setup-library", str(LIBRARY)]


def fake_ros_root(directory):
    root = Path(directory) / "opt-ros"
    (root / "jazzy").mkdir(parents=True)
    (root / "jazzy/setup.bash").write_text("# fake\n")
    return root


class FactTests(unittest.TestCase):
    def setUp(self):
        self.bundle = kb.load(FIXTURE)
        self.base = {"robot_ip": "192.168.1.5", "arm_type": "demo5", "ros_distro": "jazzy"}

    def facts(self, **extra):
        return kb.validate_facts(self.bundle, {**self.base, **extra})

    def test_coercion_and_defaults(self):
        facts = self.facts(domain_id="7", use_mock_hardware="yes", namespace="/arm")
        self.assertEqual(facts["domain_id"], 7)
        self.assertIs(facts["use_mock_hardware"], True)
        self.assertEqual(facts["namespace"], "/arm")
        self.assertEqual(facts["name"], "demo-arm")
        self.assertEqual(facts["timestamp_source"], "header")
        self.assertEqual(facts["network_interface"], "eth0")
        self.assertEqual(self.facts(use_mock_hardware=False)["use_mock_hardware"], False)

    def test_detect_ros_distro_from_root(self):
        with tempfile.TemporaryDirectory() as directory:
            root = fake_ros_root(directory)
            with patch.dict(os.environ, {"KINEX_BUNDLE_ROS_ROOT": str(root)}):
                self.assertEqual(kb.detect_ros_distro(self.bundle), "jazzy")
                self.assertEqual(kb.validate_facts(self.bundle, {"robot_ip": "10.0.0.1", "arm_type": "demo10"})["ros_distro"], "jazzy")
                (root / "humble").mkdir()
                self.assertEqual(kb.detect_ros_distro(self.bundle), "jazzy")
                shutil.rmtree(root / "jazzy")
                self.assertIsNone(kb.detect_ros_distro(self.bundle))
                bundle = copy.deepcopy(self.bundle)
                bundle.manifest["ros"]["distros"] = []
                self.assertIsNone(kb.detect_ros_distro(bundle))
            with patch.dict(os.environ, {"KINEX_BUNDLE_ROS_ROOT": str(Path(directory) / "none")}):
                self.assertIsNone(kb.detect_ros_distro(self.bundle))
                self.assertNotIn("ros_distro", kb.validate_facts(self.bundle, {"robot_ip": "10.0.0.1", "arm_type": "demo10"}))


class PreflightTests(unittest.TestCase):
    def test_missing_apt_blocks_provisioning_until_external_installation(self):
        # Both preflight requirements and pins must stay read-only with --install.
        for preflight in (False, True):
            for allow in (False, True):
                with self.subTest(preflight=preflight, allow=allow), tempfile.TemporaryDirectory() as temporary:
                    directory = Path(temporary)
                    data = {"version": 1, "name": "sensor", "device": {"type": "other"}, "facts": [],
                            "pins": {"apt": ["driver:amd64=1"], "pip": ["example==1"],
                                     "git": [{"url": "https://example.invalid/driver.git", "rev": "v1", "build": "colcon"}]}}
                    if preflight:
                        data["preflight"] = [{"id": "apt", "kind": "apt", "packages": ["driver:amd64=1", "extra"]}]
                    kb.write_yaml(directory / "bundle.yaml", data)
                    (directory / "driver.py").write_text("# driver\n")
                    installed, commands = set(), []
                    def run(argv, **kwargs):
                        commands.append(argv)
                        if argv[0] == "dpkg":
                            return subprocess.CompletedProcess(argv, 0, "amd64\n", "")
                        self.assertEqual(argv[0], "dpkg-query", "dependency checks must not execute apt, sudo or builds")
                        return subprocess.CompletedProcess(argv, 0 if argv[-1] in installed else 1, "installed\tok\t1\tamd64\n", "")
                    args = [*LIBRARIES, *(["--install"] if allow else [])]
                    with patch.object(bundle_install, "_run", side_effect=run), \
                            patch.object(bundle_install, "_install_pip", return_value=[]) as pip, \
                            patch.object(bundle_install, "_checkout_git", return_value=[]) as git, \
                            patch.object(bundle_install, "_build_colcon", return_value=[]) as build, \
                            patch.dict(os.environ, {"KINEX_BUNDLE_SKIP_INSTALL": "0"}):
                        output = io.StringIO()
                        with contextlib.redirect_stdout(output):
                            self.assertEqual(kb.provision(directory, args), 2)
                        result = json.loads(output.getvalue())
                        need = result["needs"][0]
                        self.assertEqual(need["kind"], "apt")
                        self.assertEqual(split(need["command"]), ["sudo", "apt-get", "install", "-y", "--no-remove", *need["packages"]])
                        self.assertIn("driver:amd64=1", need["packages"])
                        self.assertFalse(kb.State(directory).done("preflight" if preflight else "install"))
                        self.assertFalse((directory / "ros/generations").exists())
                        for action in (pip, git, build):
                            action.assert_not_called()
                        # Simulate the user installing the packages, then resume.
                        installed.update(["driver", "extra"])
                        output = io.StringIO()
                        with contextlib.redirect_stdout(output):
                            code = kb.provision(directory, args)
                        result = json.loads(output.getvalue())
                        self.assertEqual(code, 0 if allow else 2, result)
                        if allow:
                            for action in (pip, git, build):
                                action.assert_called_once()
                            self.assertTrue(kb.State(directory).done("install"))
                            self.assertTrue((Path(result["generations"]["sensor"]) / "profile.generated.json").is_file())
                        else:
                            self.assertEqual([need["kind"] for need in result["needs"]], ["pip", "git"])
                            for action in (pip, git, build):
                                action.assert_not_called()
                    self.assertTrue(commands)


class ProvisionTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="kinex bundle 'quoted' ")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / "sources/demo-arm"
        shutil.copytree(FIXTURE, self.source)
        self.directory = self.root / "devices/left"
        self.ros = fake_ros_root(self.root)
        self.env = patch.dict(os.environ, {"KINEX_BUNDLE_SKIP_INSTALL": "1", "KINEX_BUNDLE_ROS_ROOT": str(self.ros)})
        self.env.start()
        self.addCleanup(self.env.stop)

    def run_provision(self, *extra, steps=None, facts=True):
        args = ["--dir", str(self.directory), *LIBRARIES]
        if facts:
            for fact in ("name=left", "robot_ip=10.0.0.1", "arm_type=demo5", "ros_distro=jazzy", "use_mock_hardware=true"):
                args += ["--fact", fact]
        output = io.StringIO()
        def urdf(bundle, facts, state):
            (bundle.directory / "model.urdf").write_text('<robot name="test"/>')
        with contextlib.redirect_stdout(output):
            code = kb.provision(self.source, [*args, *extra], steps=steps if steps is not None else {"urdf": urdf})
        return code, json.loads(output.getvalue())

    def generation(self, *args, **kwargs):
        code, result = self.run_provision(*args, **kwargs)
        self.assertEqual(code, 0, result)
        return Path(result["generations"]["left"])

    def test_questionnaire_missing_facts_and_explicit_roots_before_writes(self):
        code, questionnaire = self.run_provision("--questionnaire", facts=False)
        self.assertEqual(code, 0)
        self.assertTrue(questionnaire)
        self.assertFalse(self.directory.exists())
        code, result = self.run_provision(facts=False)
        self.assertEqual(code, 2)
        self.assertEqual(result["status"], "needs")
        self.assertFalse(self.directory.exists())
        code, result = self.run_provision("--setup-library", str(self.root / "missing"))
        self.assertEqual(code, 1)
        self.assertIn("absolute setup library", result["error"])
        self.assertFalse(self.directory.exists())

    def test_complete_generation_is_resumable_and_pins_all_runtime_paths(self):
        generation = self.generation()
        self.assertEqual(self.generation(facts=False), generation)
        _, result = self.run_provision(facts=False)
        commands = [split(command) for command in result["next"] if command.startswith("bash ")]
        self.assertEqual(commands, [["bash", str(generation / "stack.sh"), "start"], ["bash", str(generation / "check.sh")]])
        self.assertEqual(list((self.directory / "ros/staging").iterdir()), [])
        self.assertFalse((self.directory / "profile.yaml").exists())
        self.assertFalse((self.directory / "DEVICE.md").exists())
        self.assertFalse((generation / "DEVICE.md").exists())
        profile = json.loads((generation / "profile.generated.json").read_text())
        self.assertEqual(self.directory / profile["access"]["driver"]["entry"], generation / "driver.py")
        self.assertEqual(profile["access"]["driver"]["interpreter"], str(generation / "ros-python"))
        self.assertEqual(self.directory / profile["intrinsics"]["model"]["path"], generation / "model.urdf")
        self.assertNotIn("domain_id", profile["access"]["connection"])
        result = subprocess.run([str(generation / "ros-python"), "-c", "import kinex, kinex_ros; print(kinex_ros.__file__)"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(str(generation / "python"), result.stdout)
        self.assertEqual({file.name for file in (generation / "python/kinex_ros").iterdir() if file.name != "__pycache__"},
                         {"__init__.py", "bundle_manifest.py", "ros2.py", "ros2_drivers.py", "ros2_check.py"})
        for name in ("provision.py", "setup.sh"):
            self.assertFalse((generation / name).exists())

    def test_unrelated_registered_devices_are_not_claimed(self):
        self.directory.mkdir(parents=True)
        for name, kind in (("other", "joint"), ("left", "imu")):
            with self.subTest(name=name, kind=kind):
                profile = {"name": name, "type": kind, "loaded": False}
                kb.write_yaml(self.directory / "profile.yaml", profile)
                code, result = self.run_provision()
                self.assertEqual(code, 1, result)
                self.assertFalse((self.directory / "state.json").exists())
                self.assertEqual(kb.read_yaml(self.directory / "profile.yaml"), profile)

    def test_vendor_and_finalization_failures_leave_selected_generation_unchanged(self):
        first = self.generation()
        profile = (first / "profile.generated.json").read_bytes()
        (self.directory / "profile.yaml").write_bytes(profile)
        def fail(bundle, facts, state):
            (bundle.directory / "driver.py").write_text("# partial\n")
            raise RuntimeError("interrupted vendor step")
        code, result = self.run_provision("--reset", steps={"vendor": fail})
        self.assertEqual(code, 1)
        self.assertIn("interrupted vendor", result["error"])
        with patch.object(Path, "rename", side_effect=OSError("rename failed")):
            code, result = self.run_provision("--reset")
        self.assertEqual(code, 1)
        self.assertEqual((self.directory / "profile.yaml").read_bytes(), profile)
        self.assertEqual((first / "profile.generated.json").read_bytes(), profile)
        self.assertNotEqual(self.generation(), first)


if __name__ == "__main__":
    unittest.main()

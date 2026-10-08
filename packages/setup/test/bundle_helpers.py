"""kinex_ros.bundle: manifest validation, facts, rendering, state and fixture provisioning."""

import copy
import contextlib
import io
import json
import os
import signal
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from shlex import quote, split
from unittest.mock import patch

import yaml

from kinex_ros import bundle as kb
from kinex_ros import bundle_install, bundle_manifest

FIXTURE = Path(__file__).parent / "fixtures/bundles/demo-arm"
LIBRARY = Path(__file__).parents[1] / "assets/python"
CORE_LIBRARY = Path(__file__).parents[2] / "core/assets/python"
LIBRARIES = ["--core-library", str(CORE_LIBRARY), "--setup-library", str(LIBRARY)]
GENERATED = ["ros-python", "stack.sh", "check.sh", "cyclonedds.xml", "profile.generated.json",
             "robot.generated.json", "recipe.json", "facts.yaml", "state.json", "model.urdf"]


def manifest():
    return yaml.safe_load((FIXTURE / "bundle.yaml").read_text())


def fake_ros_root(directory):
    root = Path(directory) / "opt-ros"
    (root / "jazzy").mkdir(parents=True)
    (root / "jazzy/setup.bash").write_text("# fake\n")
    return root


class ManifestTests(unittest.TestCase):
    def test_fixture_manifest_validates_and_normalizes(self):
        normalized = kb.validate_manifest(manifest())
        self.assertEqual(normalized["name"], "demo-arm")
        self.assertEqual(normalized["device"], {"type": "joint"})
        self.assertEqual(normalized["ros"]["rmw"], "rmw_cyclonedds_cpp")
        self.assertEqual(normalized["stack"]["stop"], {"signal": "INT", "timeout_s": 10})
        self.assertTrue(all(fact["ask"] in (True, False) for fact in normalized["facts"]))
        self.assertEqual(normalized["preflight"][0], {"id": "linux", "kind": "platform", "skip_when": None, "value": "linux"})

    def test_rejections_name_the_field_path(self):
        cases = [
            ({"version": 2}, "version must be 1"),
            ({"extra": 1}, "manifest: unknown keys extra"),
            ({"device": {"type": "toaster"}}, "device.type must be one of"),
            ({"name": "-bad"}, "name must match"),
            ({"facts": [{"key": "x", "type": "enum"}]}, "facts[0].enum is required for type enum"),
            ({"facts": [{"key": "x", "type": "string", "min": 1}]}, "facts[0].min applies to type int only"),
            ({"facts": [{"key": "x", "type": "string", "pattern": "("}]}, "facts[0].pattern is not a valid regex"),
            ({"facts": [{"key": "x", "type": "string"}, {"key": "x", "type": "int"}]}, "facts[1].key duplicates x"),
            ({"facts": [{"key": "x", "type": "string", "required": {"when": "a ="}}]}, "facts[0].required.when"),
            ({"preflight": [{"id": "p", "kind": "sonar"}]}, "preflight[0].kind must be one of"),
            ({"preflight": [{"id": "p", "kind": "file"}]}, "preflight[0].path is required"),
            ({"manual_steps": [{"id": "m", "when": "later", "text": "t"}]}, "manual_steps[0].when must be one of"),
            ({"stack": {"launch": {"package": "p"}}}, "stack.launch.file is required"),
            ({"stack": {"stop": {"signal": "HUP"}}}, "stack.stop.signal must be one of"),
            ({"recipe": {"nodes": [{"id": "n", "kind": "verify", "skill": "s"}]}}, "recipe.nodes[0].title is required"),
            ({"recipe": {"nodes": [{"id": "n", "title": "t", "kind": "inspect", "skill": "s"}]}}, "recipe.nodes[0].kind must be one of"),
            ({"satellites": [{"bundle": "x"}]}, "satellites[0].name is required"),
            ({"secrets": ["lower"]}, "secrets[0] must match"),
            ({"pins": {"git": [{"url": "u", "rev": "r", "build": "make"}]}}, "pins.git[0].build must be one of"),
            ({"profile": {"access": {"driver": {"entry": "x.py"}}}}, "profile.access.driver: unknown keys entry"),
        ]
        for patch_data, message in cases:
            data = {**manifest(), **patch_data}
            with self.assertRaises(kb.BundleError, msg=message) as raised:
                kb.validate_manifest(data)
            self.assertIn(message, str(raised.exception))

    def test_missing_required_sections(self):
        for key in ("name", "device", "facts"):
            data = manifest()
            del data[key]
            with self.assertRaises(kb.BundleError) as raised:
                kb.validate_manifest(data)
            self.assertEqual(str(raised.exception), f"{key} is required")

    def test_load_reports_manifest_path(self):
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / "bundle.yaml").write_text("version: 1\nname: x\n")
            with self.assertRaises(kb.BundleError) as raised:
                kb.load(directory)
            self.assertIn("bundle.yaml: device is required", str(raised.exception))
            with self.assertRaises(kb.BundleError):
                kb.load(Path(directory) / "absent")


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

    def test_rejections(self):
        cases = [({"robot_ip": "not-an-ip"}, "facts.robot_ip must be an IP address"),
                 ({"arm_type": "demo7"}, "facts.arm_type must be one of demo5, demo10"),
                 ({"domain_id": "300"}, "facts.domain_id must be <= 232"),
                 ({"domain_id": "-1"}, "facts.domain_id must be >= 0"),
                 ({"domain_id": "seven"}, "facts.domain_id must be an integer"),
                 ({"namespace": "9bad"}, "facts.namespace must match"),
                 ({"use_mock_hardware": "maybe"}, "facts.use_mock_hardware must be true or false"),
                 ({"unknown": "1"}, "facts.unknown is not declared"),
                 ({"ROBOT_AES_KEY": "abc"}, "ROBOT_AES_KEY is a secret")]
        for extra, message in cases:
            with self.assertRaises(kb.BundleError) as raised:
                self.facts(**extra)
            self.assertIn(message, str(raised.exception))
            self.assertNotIsInstance(raised.exception, kb.MissingFacts)

    def test_missing_required_facts_carry_prompts(self):
        with self.assertRaises(kb.MissingFacts) as raised:
            kb.validate_facts(self.bundle, {"ros_distro": "jazzy"})
        self.assertEqual([entry["key"] for entry in raised.exception.missing], ["robot_ip", "arm_type"])
        self.assertEqual(raised.exception.missing[0], {"key": "robot_ip", "prompt": "Controller IP", "type": "ip", "enum": None, "default": None})
        self.assertEqual(raised.exception.missing[1]["enum"], ["demo5", "demo10"])

    def test_conditional_required_uses_safe_evaluator(self):
        bundle = copy.deepcopy(self.bundle)
        bundle.manifest["facts"].append({"key": "aes_hint", "type": "string", "required": {"when": "conn_type == 'webrtc' and version(firmware) >= '1.1.15'"},
                                         "enum": None, "pattern": None, "min": None, "max": None, "default": None, "ask": True, "description": "AES hint"})
        self.assertNotIn("aes_hint", kb.validate_facts(bundle, self.base))
        self.assertNotIn("aes_hint", kb.validate_facts(bundle, {**self.base, "conn_type": "webrtc", "firmware": "1.1.14"}))
        with self.assertRaises(kb.MissingFacts) as raised:
            kb.validate_facts(bundle, {**self.base, "conn_type": "webrtc", "firmware": "1.1.15"})
        self.assertEqual(raised.exception.missing[0]["key"], "aes_hint")
        self.assertEqual(kb.validate_facts(bundle, {**self.base, "conn_type": "webrtc", "firmware": "1.2", "aes_hint": "x"})["aes_hint"], "x")

    def test_condition_grammar(self):
        facts = {"a": 2, "b": "x", "flag": True, "v": "1.10.0"}
        self.assertTrue(kb.evaluate_condition("a > 1 and (b == 'x' or not flag)", facts))
        self.assertFalse(kb.evaluate_condition("a >= 3 or b != 'x'", facts))
        self.assertTrue(kb.evaluate_condition("version(v) > '1.9.9' and version(v) < \"1.11\"", facts))
        self.assertTrue(kb.evaluate_condition("flag == true", facts))
        self.assertFalse(kb.evaluate_condition("missing == 'x'", facts))
        self.assertFalse(kb.evaluate_condition("missing > 1", facts))
        for bad in ("a +", "__import__('os')", "(a > 1", "a > 1 b"):
            with self.assertRaises(kb.BundleError):
                kb.evaluate_condition(bad, facts)

    def test_detect_ros_distro_from_root(self):
        with tempfile.TemporaryDirectory() as directory:
            root = fake_ros_root(directory)
            with patch.dict(os.environ, {"KINEX_BUNDLE_ROS_ROOT": str(root)}):
                self.assertEqual(kb.detect_ros_distro(self.bundle), "jazzy")
                self.assertEqual(kb.validate_facts(self.bundle, {"robot_ip": "10.0.0.1", "arm_type": "demo10"})["ros_distro"], "jazzy")
                (root / "humble").mkdir()
                self.assertEqual(kb.detect_ros_distro(self.bundle), "humble")
                (root / "rolling").mkdir()
                bundle = copy.deepcopy(self.bundle)
                bundle.manifest["ros"]["distros"] = []
                self.assertIsNone(kb.detect_ros_distro(bundle))
            with patch.dict(os.environ, {"KINEX_BUNDLE_ROS_ROOT": str(Path(directory) / "none")}):
                self.assertIsNone(kb.detect_ros_distro(self.bundle))
                self.assertNotIn("ros_distro", kb.validate_facts(self.bundle, {"robot_ip": "10.0.0.1", "arm_type": "demo10"}))

    def test_questionnaire_lists_askable_facts_only(self):
        entries = kb.questionnaire(self.bundle)
        self.assertEqual([entry["key"] for entry in entries], ["robot_ip", "arm_type", "ros_distro", "domain_id", "namespace", "name", "conn_type"])
        self.assertEqual(entries[0], {"key": "robot_ip", "prompt": "Controller IP", "type": "ip", "enum": None, "default": None, "required": True})
        self.assertEqual(entries[3], {"key": "domain_id", "prompt": "domain_id", "type": "int", "enum": None, "default": 0, "required": False})

    def test_redact_masks_secret_looking_keys(self):
        self.assertEqual(kb.redact({"robot_ip": "1.2.3.4", "api_token": "abc", "Password": "x"}), {"robot_ip": "1.2.3.4", "api_token": "***", "Password": "***"})


class RenderTests(unittest.TestCase):
    def test_render_is_strict_and_lowercases_booleans(self):
        facts = {"name": "arm", "flag": True, "count": 3}
        self.assertEqual(kb.render("${name}:${flag}:${count}", facts), "arm:true:3")
        with self.assertRaises(kb.BundleError) as raised:
            kb.render("${name}/${missing}", facts)
        self.assertIn("'missing'", str(raised.exception))
        with self.assertRaises(kb.BundleError):
            kb.render("$", facts)
        self.assertEqual(kb.render_tree({"a": ["${name}", {"b": "${count}"}], "n": 1}, facts), {"a": ["arm", {"b": 3}], "n": 1})
        with patch.dict(os.environ, {"KINEX_BUNDLE_ROS_ROOT": "/ros"}):
            self.assertEqual(kb.render("${ros_root}/x", {}), "/ros/x")

    def test_exact_placeholders_preserve_types_without_aliasing_or_recursive_expansion(self):
        facts = {"count": 640, "flag": False, "missing_value": None, "names": ["a", "b"],
                 "config": {"enabled": True, "literal": "${not_a_fact}"}}
        rendered = kb.render_tree({"width": "${count}", "flag": "$flag", "unset": "${missing_value}",
                                   "names": "${names}", "config": "${config}", "text": "width=${count}, flag=${flag}"}, facts)
        self.assertEqual(rendered, {"width": 640, "flag": False, "unset": None, "names": ["a", "b"],
                                    "config": {"enabled": True, "literal": "${not_a_fact}"}, "text": "width=640, flag=false"})
        rendered["names"].append("c")
        rendered["config"]["enabled"] = False
        self.assertEqual(facts["names"], ["a", "b"])
        self.assertIs(facts["config"]["enabled"], True)
        with self.assertRaises(kb.BundleError):
            kb.render_tree({"unknown": "${not_a_fact}"}, facts)
        with patch.dict(os.environ, {"KINEX_BUNDLE_ROS_ROOT": "/ros"}):
            self.assertEqual(kb.render_tree("${ros_root}", {"ros_root": "ignored"}), "/ros")
        self.assertEqual(kb.render_tree("$${count}", facts), "${count}")

    @unittest.skipUnless(sys.platform.startswith("linux"), "requires POSIX process groups")
    def test_stack_stop_waits_for_group_after_launcher_exits(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            bundle = kb.Bundle(directory, kb.validate_manifest({"version": 1, "name": "arm", "device": {"type": "joint"},
                "facts": [], "stack": {"stop": {"timeout_s": 1}}}), {})
            (directory / "stack.sh").write_text(kb.render_stack_sh(bundle, {}))
            (directory / "run").mkdir()
            program = ("import signal,sys,time; from pathlib import Path; "
                       "signal.signal(signal.SIGINT, signal.SIG_IGN if sys.argv[2] == 'worker' else lambda *_: sys.exit(0)); "
                       "Path(sys.argv[1]).touch(); time.sleep(30)")
            leader = subprocess.Popen([sys.executable, "-c", program, str(directory / "leader-ready"), "leader"], preexec_fn=os.setpgrp)
            worker = stop = None
            try:
                worker = subprocess.Popen([sys.executable, "-c", program, str(directory / "worker-ready"), "worker"],
                                          preexec_fn=lambda: os.setpgid(0, leader.pid))
                deadline = time.monotonic() + 3
                while not all((directory / f"{name}-ready").exists() for name in ("leader", "worker")):
                    self.assertLess(time.monotonic(), deadline, "process group did not start")
                    time.sleep(.01)
                (directory / "run/stack.pid").write_text(str(leader.pid))
                stop = subprocess.Popen(["bash", str(directory / "stack.sh"), "stop"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                self.assertEqual(leader.wait(timeout=3), 0)
                self.assertEqual(worker.wait(timeout=4), -signal.SIGTERM)
                stdout, stderr = stop.communicate(timeout=3)
                self.assertEqual(stop.returncode, 0, stderr)
                self.assertIn("stopped", stdout)
                self.assertFalse((directory / "run/stack.pid").exists())
            finally:
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(leader.pid, signal.SIGKILL)
                leader.wait(timeout=3)
                if worker is not None:
                    worker.wait(timeout=3)
                if stop is not None and stop.poll() is None:
                    stop.kill()
                    stop.communicate(timeout=3)


class StateTests(unittest.TestCase):
    def test_skip_rerun_reset(self):
        with tempfile.TemporaryDirectory() as directory:
            state = kb.State(directory, bundle="demo-arm", bundle_version=1, source="/src")
            calls = []
            self.assertEqual(state.run("facts", {"a": 1}, lambda: calls.append(1) or "first"), "first")
            self.assertEqual(state.run("facts", {"a": 1}, lambda: calls.append(2) or "second"), "first")
            self.assertEqual(calls, [1])
            self.assertEqual(state.run("facts", {"a": 2}, lambda: calls.append(3) or "third"), "third")
            self.assertEqual(calls, [1, 3])
            stored = json.loads((Path(directory) / "state.json").read_text())
            self.assertEqual({key: stored[key] for key in ("bundle", "bundle_version", "source")},
                             {"bundle": "demo-arm", "bundle_version": 1, "source": "/src"})
            self.assertEqual(sorted(stored["steps"]["facts"]), ["at", "done", "inputs_hash", "note"])
            self.assertTrue(stored["steps"]["facts"]["done"])
            reopened = kb.State(directory)
            self.assertEqual(reopened.source, "/src")
            self.assertEqual(reopened.run("facts", {"a": 2}, lambda: calls.append(4) or "fourth"), "third")

            def failing():
                raise RuntimeError("boom")
            with self.assertRaises(RuntimeError):
                reopened.run("preflight", {}, failing)
            self.assertFalse(reopened.done("preflight"))
            self.assertEqual(reopened.steps["preflight"]["note"], "boom")
            reopened.reset()
            self.assertEqual(kb.State(directory).steps, {})
            self.assertEqual(kb.State(directory).run("facts", {"a": 2}, lambda: "fifth"), "fifth")
            self.assertFalse((Path(directory) / "state.json.tmp").exists())


@contextlib.contextmanager
def apt_host(uid=1000):
    with patch.object(sys, "platform", "linux"), patch.object(os, "geteuid", return_value=uid, create=True), \
            patch.object(bundle_install.shutil, "which", side_effect=lambda command: "/usr/bin/" + command):
        yield


@unittest.skipUnless(sys.platform.startswith("linux"), "uses POSIX process groups and /proc")
class InstallerProcessTests(unittest.TestCase):
    def test_timeout_stops_workers_even_after_the_leader_exits(self):
        handlers = {signum: signal.getsignal(signum) for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)}
        for leader_exits in (False, True):
            with self.subTest(leader_exits=leader_exits), tempfile.TemporaryDirectory() as temporary:
                ready = Path(temporary) / "worker"
                worker = ("import os, signal, time; from pathlib import Path; "
                          "signal.signal(signal.SIGTERM, signal.SIG_IGN); "
                          f"Path({str(ready)!r}).write_text(str(os.getpid())); time.sleep(60)")
                parent = ("import subprocess, sys, time; "
                          f"subprocess.Popen([sys.executable, '-c', {worker!r}]); "
                          + ("sys.exit(0)" if leader_exits else "time.sleep(60)"))
                result = bundle_install._run([sys.executable, "-c", parent], timeout=1)
                self.assertEqual(result.returncode, 124)
                self.assertTrue(ready.is_file(), "worker must start before the timeout")
                pid = int(ready.read_text())
                # Orphans can briefly remain zombies until init reaps them.
                status = Path(f"/proc/{pid}/stat")
                deadline = time.monotonic() + 1
                while status.exists():
                    try:
                        state = status.read_text().rsplit(")", 1)[1].split()[0]
                    except FileNotFoundError:
                        break
                    if state == "Z":
                        break
                    self.assertLess(time.monotonic(), deadline, "timed-out worker is still running")
                    time.sleep(.01)
        self.assertEqual({signum: signal.getsignal(signum) for signum in handlers}, handlers)


class AptTests(unittest.TestCase):
    def test_package_detection_checks_installed_state_architecture_and_version(self):
        statuses = {"python3-yaml": "deinstall ok config-files", "broken": "install reinstreq installed",
                    "held": "hold ok installed", "driver": "install ok installed"}
        def run(argv, **kwargs):
            if argv[0] == "dpkg":
                return subprocess.CompletedProcess(argv, 0, "amd64\n", "")
            want, error, status = statuses[argv[-1]].split()
            return subprocess.CompletedProcess(argv, 0, f"{status}\t{error}\t1.2.3-1\tamd64\n", "")
        packages = ["python3-yaml", "broken", "held", "driver:amd64=1.2.3-1", "driver:amd64=2.0"]
        with patch.object(bundle_install, "_run", side_effect=run):
            self.assertEqual(kb.missing_apt(packages), ["python3-yaml", "broken", "driver:amd64=2.0"])

    def test_install_cli_root_and_sudo_then_rerun_is_a_noop(self):
        for uid in (0, 1000):
            with self.subTest(uid=uid), apt_host(uid):
                commands, installed = [], set()
                def run(argv, **kwargs):
                    commands.append(argv)
                    if argv[0] == "dpkg":
                        return subprocess.CompletedProcess(argv, 0, "amd64\n", "")
                    if argv[0] == "dpkg-query":
                        return subprocess.CompletedProcess(argv, 0 if argv[-1] in installed else 1, "installed\tok\t1\tamd64\n", "")
                    prefix = [] if uid == 0 else ["sudo", "-n", "DEBIAN_FRONTEND=noninteractive"]
                    self.assertEqual(argv[:len(prefix) + 1], prefix + ["apt-get"])
                    self.assertEqual(kwargs["env"]["DEBIAN_FRONTEND"], "noninteractive")
                    if "install" in argv:
                        installed.update(argv[argv.index("--") + 1:])
                    return subprocess.CompletedProcess(argv, 0, "apt progress", "")
                with patch.object(bundle_install, "_run", side_effect=run):
                    output = io.StringIO()
                    with contextlib.redirect_stdout(output):
                        code = bundle_install.main(["python3-yaml", "ros-jazzy-rclpy", "ros-jazzy-rclpy"])
                    self.assertEqual(code, 2)
                    self.assertEqual(json.loads(output.getvalue())["needs"][0]["packages"], ["python3-yaml", "ros-jazzy-rclpy"])
                    self.assertTrue(all(argv[0] in ("dpkg", "dpkg-query") for argv in commands))
                    for _ in range(2):
                        output = io.StringIO()
                        with contextlib.redirect_stdout(output):
                            self.assertEqual(bundle_install.main(["--install", "python3-yaml", "ros-jazzy-rclpy"]), 0)
                        self.assertEqual(json.loads(output.getvalue()), {"status": "ok", "needs": []})
                effects = [argv for argv in commands if argv[0] not in ("dpkg", "dpkg-query")]
                self.assertEqual(len(effects), 2)
                self.assertIn("update", effects[0])
                self.assertIn("install", effects[1])
                self.assertEqual(installed, {"python3-yaml", "ros-jazzy-rclpy"})

    def test_failed_update_install_and_verification_remain_actionable_needs(self):
        for stage, detail in [("update", "sudo: a password is required"), ("update", "repository is not signed"),
                              ("install", "Unable to locate package ros-jazzy-driver"), ("verify", "")]:
            with self.subTest(stage=stage, detail=detail), apt_host():
                commands = []
                def run(argv, **kwargs):
                    commands.append(argv)
                    failed = stage in argv
                    return subprocess.CompletedProcess(argv, (1 if detail.startswith("sudo:") else 100) if failed else 0, "", detail if failed else "")
                with patch.object(bundle_install, "missing_apt", return_value=["ros-jazzy-driver"]), \
                        patch.object(bundle_install, "_run", side_effect=run):
                    needs = bundle_install._install_apt(["ros-jazzy-driver"], True)
                self.assertEqual(needs[0]["stage"], stage)
                if detail == "sudo: a password is required":
                    self.assertEqual(needs[0]["reason"], "sudo_authentication")
                    self.assertIn("--install --interactive --", needs[0]["command"])
                else:
                    self.assertIn(detail, needs[0]["text"])
                self.assertEqual(len(commands), 1 if stage == "update" else 2)
                self.assertEqual(needs[0]["packages"], ["ros-jazzy-driver"])

    def test_apt_only_sudo_rule_retries_without_requiring_environment_permission(self):
        commands = []
        def run(argv, **kwargs):
            commands.append(argv)
            self.assertEqual(kwargs["env"]["LC_ALL"], "C")
            if "DEBIAN_FRONTEND=noninteractive" in argv:
                return subprocess.CompletedProcess(argv, 1, "", "sudo: sorry, you are not allowed to set "
                                                   "the following environment variables: DEBIAN_FRONTEND\n")
            self.assertEqual(argv[:3], ["sudo", "-n", "apt-get"])
            return subprocess.CompletedProcess(argv, 0, "", "")
        with apt_host(), patch.object(bundle_install, "_run", side_effect=run), \
                patch.object(bundle_install, "missing_apt", side_effect=[["driver"], []]):
            self.assertEqual(bundle_install._install_apt(["driver"], True), [])
        self.assertEqual(len(commands), 3)
        self.assertIn("update", commands[0])
        self.assertIn("update", commands[1])
        self.assertEqual(commands[2], ["sudo", "-n", "apt-get", "install", "-y", "--no-remove", "--", "driver"])

    def test_interactive_authentication_retries_the_failed_stage_and_verifies(self):
        commands = []
        def run(argv, **kwargs):
            commands.append(argv)
            self.assertEqual(kwargs["stdout"], sys.stdin.fileno())
            return subprocess.CompletedProcess(argv, 1 if len(commands) == 1 else 0, "", "sudo: a password is required")
        with apt_host(), patch.object(sys.stdin, "isatty", return_value=True), \
                patch.object(bundle_install, "_run", side_effect=run), \
                patch.object(bundle_install, "_sudo_authenticate", return_value=0) as auth, \
                patch.object(bundle_install, "missing_apt", side_effect=[["driver"], []]):
            self.assertEqual(bundle_install._install_apt(["driver"], True, True), [])
        auth.assert_called_once_with()
        self.assertEqual(commands[0], commands[1])
        self.assertIn("install", commands[2])

    def test_streamed_progress_keeps_stdin_closed_and_stderr_available(self):
        with tempfile.TemporaryFile(mode="w+") as progress:
            result = bundle_install._run([sys.executable, "-c",
                "import sys; assert sys.stdin.read() == ''; print('apt progress'); "
                "print('apt failure', file=sys.stderr); sys.exit(100)"], stdout=progress)
            progress.seek(0)
            self.assertEqual(progress.read(), "apt progress\n")
        self.assertEqual(result.returncode, 100)
        self.assertEqual(result.stdout, "")
        self.assertEqual(result.stderr, "apt failure\n")

    def test_authentication_requires_explicit_terminal_opt_in_and_stops_on_failure(self):
        for interactive, tty, auth_code in [(False, True, 0), (True, False, 0), (True, True, 1), (True, True, 124), (True, True, 0)]:
            with self.subTest(interactive=interactive, tty=tty, auth_code=auth_code), apt_host(), \
                    patch.object(sys.stdin, "isatty", return_value=tty), \
                    patch.object(bundle_install, "missing_apt", return_value=["driver"]), \
                    patch.object(bundle_install, "_run", return_value=subprocess.CompletedProcess([], 1, "", "sudo: a password is required")) as run, \
                    patch.object(bundle_install, "_sudo_authenticate", return_value=auth_code) as auth:
                need = bundle_install._install_apt(["driver"], True, interactive)[0]
                self.assertEqual(need["reason"], "sudo_authentication")
                self.assertEqual(auth.call_count, int(interactive and tty))
                self.assertEqual(run.call_count, 2 if interactive and tty and not auth_code else 1)
                self.assertTrue(all(call.kwargs["stdout"] == (sys.stdin.fileno() if interactive and tty else subprocess.PIPE)
                                    for call in run.call_args_list))
                if interactive and tty and auth_code:
                    self.assertEqual(need["stage"], "authenticate")
                self.assertTrue(all("install" not in call.args[0] for call in run.call_args_list))

    @unittest.skipUnless(sys.platform.startswith("linux"), "requires terminal attributes")
    def test_sudo_reads_only_the_terminal_descriptor_and_restores_it_on_timeout(self):
        import termios
        for timeout in (False, True):
            with self.subTest(timeout=timeout), patch.object(sys.stdin, "fileno", return_value=7), \
                    patch.object(os, "dup", return_value=12), \
                    patch.object(os, "close") as close, patch.object(termios, "tcgetattr", return_value=[1]) as attributes, \
                    patch.object(termios, "tcsetattr") as restore, patch.object(subprocess, "run", \
                    side_effect=subprocess.TimeoutExpired("sudo", 300) if timeout else None,
                    return_value=subprocess.CompletedProcess([], 0)) as run:
                self.assertEqual(bundle_install._sudo_authenticate(), 124 if timeout else 0)
            self.assertEqual(run.call_args.args[0], ["sudo", "-S", "-p", "[Kinex] sudo password for %u: ", "-v"])
            self.assertEqual([run.call_args.kwargs[name] for name in ("stdin", "stdout", "stderr")], [12, 12, 12])
            self.assertNotIn("input", run.call_args.kwargs)
            self.assertNotIn("capture_output", run.call_args.kwargs)
            attributes.assert_called_once_with(12)
            restore.assert_called_once_with(12, termios.TCSANOW, [1])
            close.assert_called_once_with(12)

    def test_unsupported_hosts_and_invalid_package_specs_never_run_apt(self):
        with patch.object(bundle_install, "_run") as run:
            for platform in ("win32", "darwin"):
                with patch.object(sys, "platform", platform):
                    self.assertEqual(bundle_install._install_apt(["ros-jazzy-rclpy"], True)[0]["kind"], "platform")
            with patch.object(sys, "platform", "linux"), patch.object(bundle_install.shutil, "which", return_value=None):
                self.assertEqual(bundle_install._install_apt(["ros-jazzy-rclpy"], True)[0]["kind"], "platform")
            for spec in ("--allow-unauthenticated", "driver-", "driver-:amd64", "driver;true", "driver other", "./driver.deb", "driver=1;true"):
                with self.subTest(spec=spec), self.assertRaises(kb.BundleError):
                    bundle_install._install_apt([spec], True)
            run.assert_not_called()

    def test_plus_names_and_version_pins_are_valid(self):
        packages = ["g++", "g++:amd64", "g++=4:13.2.0-7ubuntu1", "libc++:arm64=1.0+2-3", "g++"]
        self.assertEqual(bundle_install._apt_specs(packages), packages[:-1])

    @unittest.skipUnless(sys.platform.startswith("linux") and bundle_install.shutil.which("dpkg-query")
                         and bundle_install.shutil.which("dpkg"), "requires the Debian package database tools")
    def test_real_dpkg_multiarch_plus_names_and_architecture_independent_packages(self):
        native = subprocess.check_output(["dpkg", "--print-architecture"], text=True).strip()
        foreign = "i386" if native != "i386" else "amd64"
        with tempfile.TemporaryDirectory() as directory:
            records = [
                ("g++", native, "install ok installed"),
                ("multiarch", foreign, "install ok installed"),
                ("multiarch", native, "install ok installed"),
                ("foreign-only", foreign, "install ok installed"),
                ("broken-native", foreign, "install ok installed"),
                ("broken-native", native, "deinstall ok config-files"),
                ("portable", "all", "install ok installed"),
            ]
            (Path(directory) / "arch").write_text(f"{native}\n{foreign}\n")
            (Path(directory) / "status").write_text("".join(
                f"Package: {name}\nStatus: {status}\nArchitecture: {arch}\n"
                f"Multi-Arch: {'foreign' if arch == 'all' else 'same'}\nVersion: 1.2.3-1\n"
                "Maintainer: Test <test@example.invalid>\nDescription: test fixture\n\n"
                for name, arch, status in records))
            packages = ["g++", "g++=1.2.3-1", "g++=2.0", "multiarch", f"multiarch:{foreign}",
                        "multiarch=2.0", "foreign-only", f"foreign-only:{foreign}", "broken-native",
                        "portable", f"portable:{native}", "absent"]
            with patch.dict(os.environ, {"DPKG_ADMINDIR": directory}):
                self.assertEqual(kb.missing_apt(packages),
                                 ["g++=2.0", "multiarch=2.0", "foreign-only", "broken-native", "absent"])
                with patch.object(bundle_install, "_run", wraps=bundle_install._run) as run:
                    self.assertEqual(bundle_install._install_apt(["g++", "multiarch", "portable"], True), [])
                self.assertTrue(all(call.args[0][0] in ("dpkg", "dpkg-query") for call in run.call_args_list))

    @unittest.skipUnless(os.name == "posix", "recovery commands use a POSIX shell")
    def test_authentication_recovery_ignores_workspace_python_replacements(self):
        with tempfile.TemporaryDirectory(prefix="kinex recovery ") as directory:
            root = Path(directory)
            (root / "kinex").mkdir()
            replacement = "from pathlib import Path\nPath('workspace-code-ran').touch()\nraise RuntimeError('workspace replacement')\n"
            for name in ("kinex/__init__.py", "kinex/bundle_install.py", "sitecustomize.py", "json.py"):
                (root / name).write_text(replacement)
            command = bundle_install._sudo_need(["--invalid-package"], "update", 1)["command"]
            # Invalid package syntax rejects before apt can run. An inherited
            # Python home/path must not redirect the copyable recovery command.
            result = subprocess.run(command, shell=True, cwd=root, capture_output=True, text=True,
                                    env={**os.environ, "PYTHONHOME": str(root), "PYTHONPATH": str(root), "PATH": ""})
            self.assertEqual(result.returncode, 1, result.stderr)
            self.assertIn("invalid apt package", json.loads(result.stdout)["error"])
            self.assertFalse((root / "workspace-code-ran").exists())

    def test_cli_bootstraps_without_site_packages_or_a_bundle(self):
        # -S prevents importing site-packages (including PyYAML and ROS).
        # Empty PATH ensures this real subprocess cannot invoke apt or sudo.
        result = subprocess.run([sys.executable, "-S", "-m", "kinex_ros.bundle_install", "--install", "python3-yaml"],
                                capture_output=True, text=True, env={**os.environ, "PYTHONPATH": str(LIBRARY), "PATH": ""})
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertEqual(json.loads(result.stdout)["needs"][0]["kind"], "platform")


class PreflightTests(unittest.TestCase):
    def test_needs_entries_with_installs_skipped(self):
        with tempfile.TemporaryDirectory() as directory:
            bundle = kb.load(FIXTURE)
            bundle.directory = bundle.device_directory = bundle.target_directory = Path(directory)
            root = fake_ros_root(directory)
            facts = {"robot_ip": "10.0.0.1", "arm_type": "demo5", "ros_distro": "humble", "use_mock_hardware": False}
            with patch.dict(os.environ, {"KINEX_BUNDLE_SKIP_INSTALL": "1", "KINEX_BUNDLE_ROS_ROOT": str(root)}):
                report = kb.preflight_report(bundle, facts)
                self.assertEqual([(entry["id"], entry["status"]) for entry in report],
                                 [("linux", "skipped"), ("distro", "needs"), ("python_version", "ok"), ("reach", "skipped"),
                                  ("apt", "skipped"), ("secrets", "needs")])
                needs = kb.preflight(bundle, facts)
                self.assertEqual([need["kind"] for need in needs], ["file", "env"])
                self.assertIn(str(root / "humble" / "setup.bash").replace("\\", "/").split("/")[-2], needs[0]["text"])
                self.assertEqual(needs[1]["names"], ["ROBOT_AES_KEY"])
                self.assertIn("env.sh", needs[1]["text"])
                (Path(directory) / "env.sh").write_text("export ROBOT_AES_KEY=do-not-print\n")
                self.assertEqual([need["id"] for need in kb.preflight(bundle, {**facts, "ros_distro": "jazzy"})], [])
                self.assertEqual([entry["status"] for entry in kb.preflight_report(bundle, {**facts, "use_mock_hardware": True})][-1], "skipped")
                self.assertEqual(kb.install(bundle, facts), [])

    def test_apt_need_lists_one_install_command(self):
        bundle = kb.load(FIXTURE)
        with apt_host(), patch.object(bundle_install, "missing_apt", return_value=["ros-jazzy-demo-driver"]), patch.dict(os.environ, {"KINEX_BUNDLE_SKIP_INSTALL": "0"}):
            needs = kb.install(bundle, {"ros_distro": "jazzy"})
        self.assertEqual(needs, [{"kind": "apt", "id": "apt", "packages": ["ros-jazzy-demo-driver"],
                                  "command": "sudo apt-get install -y --no-remove ros-jazzy-demo-driver", "text": "missing system packages: ros-jazzy-demo-driver"}])

    def test_provisioning_requires_install_for_pip_git_and_builds(self):
        for allow in (False, True):
            with self.subTest(allow=allow), tempfile.TemporaryDirectory() as temporary:
                source = Path(temporary) / "source"
                target = Path(temporary) / "sensor"
                kb.write_yaml(source / "bundle.yaml", {
                    "version": 1, "name": "sensor", "device": {"type": "other"},
                    "facts": [{"key": "version", "type": "string", "default": "1.2"}],
                    "pins": {"apt": ["already-installed"], "pip": ["example==${version}"],
                             "git": [{"url": "https://example.invalid/driver.git", "rev": "v${version}", "build": "colcon"}]},
                })
                (source / "driver.py").write_text("# fixture driver\n")
                calls = []
                def run(argv, **kwargs):
                    calls.append(argv)
                    return subprocess.CompletedProcess(argv, 0, "", "")
                output = io.StringIO()
                with apt_host(), patch.dict(os.environ, {"KINEX_BUNDLE_SKIP_INSTALL": "0"}), \
                        patch.object(bundle_install, "missing_apt", return_value=[]), \
                        patch.object(bundle_install, "_run", side_effect=run), contextlib.redirect_stdout(output):
                    code = kb.provision(source, ["--dir", str(target), *LIBRARIES, *(["--install"] if allow else [])])
                result = json.loads(output.getvalue())
                self.assertEqual(code, 0 if allow else 2, result)
                self.assertEqual(kb.State(target).done("install"), allow)
                if allow:
                    self.assertEqual([argv[0] for argv in calls], ["/usr/bin/python3", "git", "git", "git", "bash"])
                    self.assertIn("example==1.2", calls[0])
                    self.assertIn("v1.2", calls[2])
                    self.assertIn("colcon build", calls[-1][-1])
                else:
                    self.assertEqual(calls, [])
                    self.assertEqual([need["kind"] for need in result["needs"]], ["pip", "git"])
                    self.assertTrue(all("--install" in need["text"] for need in result["needs"]))
                    self.assertEqual(result["needs"][0]["packages"], ["example==1.2"])
                    self.assertEqual(result["needs"][1]["rev"], "v1.2")
                    self.assertFalse((target / "ros/generations").exists())

    def test_env_file_names_never_exposes_values(self):
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / "env.sh").write_text("# comment\nexport A_KEY=secret-value\n  export B=2\nC=3\n")
            self.assertEqual(kb.env_file_names(directory), {"A_KEY", "B"})

    def test_install_flag_satisfies_apt_preflight_and_rechecks_the_result(self):
        for allow, sudo_ok, other_need in [(False, True, False), (True, True, False), (True, False, False), (True, True, True)]:
            with self.subTest(allow=allow, sudo_ok=sudo_ok, other_need=other_need), tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary)
                data = {"version": 1, "name": "sensor", "device": {"type": "imu"}, "facts": [],
                        "pins": {"apt": ["driver"]}, "preflight": [{"id": "apt", "kind": "apt", "packages": ["driver", "extra"]}]}
                if other_need:
                    data["preflight"].append({"id": "host", "kind": "file", "path": str(directory / "missing")})
                kb.write_yaml(directory / "bundle.yaml", data)
                (directory / "driver.py").write_text("# driver\n")
                installed, commands = set(), []
                def run(argv, **kwargs):
                    commands.append(argv)
                    if argv[0] == "dpkg":
                        return subprocess.CompletedProcess(argv, 0, "amd64\n", "")
                    if argv[0] == "dpkg-query":
                        return subprocess.CompletedProcess(argv, 0 if argv[-1] in installed else 1, "installed\tok\t1\tamd64\n", "")
                    self.assertEqual(argv[:4], ["sudo", "-n", "DEBIAN_FRONTEND=noninteractive", "apt-get"])
                    if sudo_ok and argv[4] == "install":
                        installed.update(argv[8:])
                    return subprocess.CompletedProcess(argv, 0 if sudo_ok else 1, "", "")
                output = io.StringIO()
                with apt_host(), patch.object(bundle_install, "_run", side_effect=run), patch.dict(os.environ, {"KINEX_BUNDLE_SKIP_INSTALL": "0"}), contextlib.redirect_stdout(output):
                    code = kb.provision(directory, LIBRARIES + (["--install"] if allow else []))
                sudo = [command for command in commands if command[0] == "sudo"]
                self.assertEqual(bool(sudo), allow and not other_need)
                success = allow and sudo_ok and not other_need
                self.assertEqual(code, 0 if success else 2)
                result = json.loads(output.getvalue())
                self.assertEqual(result["status"], "ok" if success else "needs")
                if success:
                    self.assertEqual(installed, {"driver", "extra"})
                    self.assertTrue(kb.State(directory).done("preflight"))
                    self.assertTrue((Path(result["generations"]["sensor"]) / "profile.generated.json").is_file())
                else:
                    self.assertIn("sudo apt-get install -y", result["needs"][0]["command"])
                    self.assertFalse(kb.State(directory).done("preflight"))

    def test_git_checkout_reuses_only_the_declared_origin(self):
        def git(*args):
            return subprocess.run(["git", *map(str, args)], check=True, capture_output=True, text=True).stdout.strip()

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            sources = [root / owner / "driver.git" for owner in ("first", "second")]
            for source in sources:
                source.mkdir(parents=True)
                git("init", "-b", "main", source)
                (source / "marker").write_text(source.parent.name)
                git("-C", source, "add", "marker")
                git("-C", source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                    "-c", "commit.gpgsign=false", "commit", "-m", "source fixture")
            bundle = kb.load(FIXTURE)
            bundle.directory = bundle.device_directory = bundle.target_directory = root / "bundle"
            pin = {"url": sources[0].as_posix(), "rev": "main", "build": None}
            self.assertEqual(bundle_install._checkout_git(bundle, {}, pin), [])
            checkout = bundle.directory / "src/driver"
            self.assertEqual((checkout / "marker").read_text(), "first")

            # The same origin can be refreshed after a dependency update.
            (sources[0] / "marker").write_text("updated")
            git("-C", sources[0], "add", "marker")
            git("-C", sources[0], "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                "-c", "commit.gpgsign=false", "commit", "-m", "source update")
            self.assertEqual(bundle_install._checkout_git(bundle, {}, pin), [])
            before = git("-C", checkout, "rev-parse", "HEAD")
            self.assertEqual((checkout / "marker").read_text(), "updated")

            # A different repository with the same basename must not reuse it.
            needs = bundle_install._checkout_git(bundle, {}, {**pin, "url": sources[1].as_posix()})
            self.assertEqual(needs[0]["reason"], "source_mismatch")
            self.assertEqual(git("-C", checkout, "rev-parse", "HEAD"), before)
            self.assertEqual((checkout / "marker").read_text(), "updated")
            self.assertEqual(git("-C", checkout, "config", "--get", "remote.origin.url"), sources[0].as_posix())

    def test_failed_checkout_prevents_workspace_build(self):
        with tempfile.TemporaryDirectory() as temporary:
            bundle = kb.load(FIXTURE)
            bundle.directory = bundle.device_directory = bundle.target_directory = Path(temporary)
            bundle.manifest["pins"] = {"apt": [], "pip": [], "git": [
                {"url": f"https://example.test/{name}.git", "rev": "abc", "build": "colcon"}
                for name in ("vendor", "dependency")]}
            calls = []
            def run(argv, **kwargs):
                calls.append(argv)
                failed = "fetch" in argv and str(bundle.directory / "src/dependency") in argv
                return subprocess.CompletedProcess(argv, 1 if failed else 0, "", "fetch failed" if failed else "")
            with patch.dict(os.environ, {"KINEX_BUNDLE_SKIP_INSTALL": "0"}), patch.object(bundle_install, "_run", side_effect=run):
                needs = bundle_install.install(bundle, {}, allow_install=True)
            self.assertEqual([(need["kind"], need["id"]) for need in needs], [("git", "git:dependency")])
            self.assertTrue(all(argv[0] == "git" for argv in calls), calls)
            self.assertFalse((bundle.directory / "ws").exists())

    def test_colcon_build_combines_declared_sources_with_quoted_paths(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / "device with 'quotes'"
            directory.mkdir()
            root = fake_ros_root(directory)
            bundle = kb.load(FIXTURE)
            bundle.directory = bundle.device_directory = bundle.target_directory = directory
            facts = kb.validate_facts(bundle, {"robot_ip": "10.0.0.1", "arm_type": "demo5", "ros_distro": "jazzy"})
            (directory / "env.sh").write_text("export BUILD_SENTINEL=present\n")
            (root / "jazzy/setup.bash").write_text("export ROS_SENTINEL=present\n")
            bin_dir = directory / "bin"
            bin_dir.mkdir()
            (bin_dir / "git").write_text("#!/bin/sh\nexit 0\n")
            (bin_dir / "colcon").write_text("#!/usr/bin/env python3\nimport json,os,sys\nfrom pathlib import Path\n"
                                            "Path(os.environ['BUILD_CAPTURE']).write_text(json.dumps({'args':sys.argv[1:],"
                                            "'env':{key:os.environ.get(key) for key in ['BUILD_SENTINEL','ROS_SENTINEL','CYCLONEDDS_URI']}}))\n")
            for file in bin_dir.iterdir():
                file.chmod(0o755)
            capture = directory / "build.json"
            bundle.manifest["pins"] = {"apt": [], "pip": [], "git": [
                {"url": f"https://example.test/{name}.git", "rev": "abc", "build": build}
                for name, build in (("vendor", "colcon"), ("dependency", "colcon"), ("assets", None))]}
            with patch.dict(os.environ, {"PATH": str(bin_dir) + os.pathsep + os.environ["PATH"], "BUILD_CAPTURE": str(capture),
                                         "KINEX_BUNDLE_ROS_ROOT": str(root), "KINEX_BUNDLE_SKIP_INSTALL": "0"}):
                needs = bundle_install.install(bundle, facts, allow_install=True)
            self.assertEqual(needs, [])
            observed = json.loads(capture.read_text())
            self.assertEqual(observed["env"], {"BUILD_SENTINEL": "present", "ROS_SENTINEL": "present", "CYCLONEDDS_URI": f"file://{directory}/cyclonedds.xml"})
            self.assertEqual(observed["args"], ["build", "--base-paths", str(directory / "src/vendor"), str(directory / "src/dependency"),
                                                "--build-base", str(directory / "ws/build"),
                                                "--install-base", str(directory / "ws/install")])


class GenerationFixture(unittest.TestCase):
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

    def run_provision(self, *extra, source=None, steps=None, facts=True):
        args = ["--dir", str(self.directory), *LIBRARIES]
        if facts:
            for fact in ("name=left", "robot_ip=10.0.0.1", "arm_type=demo5", "ros_distro=jazzy", "use_mock_hardware=true"):
                args += ["--fact", fact]
        output = io.StringIO()
        def urdf(bundle, facts, state):
            (bundle.directory / "model.urdf").write_text('<robot name="test"/>')
        with contextlib.redirect_stdout(output):
            code = kb.provision(source or self.source, [*args, *extra], steps=steps if steps is not None else {"urdf": urdf})
        return code, json.loads(output.getvalue())

    def generation(self, *args, **kwargs):
        code, result = self.run_provision(*args, **kwargs)
        self.assertEqual(code, 0, result)
        return Path(result["generations"]["left"])


class ProvisionTests(GenerationFixture):
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
        for name in ["bundle", "bundle_install", "bundle_manifest", "bundle_render", "ros2", "ros2_drivers", "ros2_check"]:
            self.assertTrue((generation / f"python/kinex_ros/{name}.py").is_file())

    def test_registered_device_can_be_provisioned_without_replacing_its_files(self):
        self.directory.mkdir(parents=True)
        profile = {"name": "left", "type": "joint", "loaded": False,
                   "intrinsics": {"source": "calibration", "home": {"joint_1": .2}}}
        kb.write_yaml(self.directory / "profile.yaml", profile)
        (self.directory / "driver.py").write_text("# existing driver\n")
        before = {file.name: file.read_bytes() for file in self.directory.iterdir()}
        generation = self.generation()
        self.assertTrue(generation.is_dir())
        for name, contents in before.items():
            self.assertEqual((self.directory / name).read_bytes(), contents)

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

    def test_legacy_manifest_does_not_override_a_foreign_ownership_receipt(self):
        shutil.copytree(self.source, self.directory)
        kb.State(self.directory, bundle="other-bundle").save()
        before = (self.directory / "state.json").read_bytes()
        code, result = self.run_provision()
        self.assertEqual(code, 1, result)
        self.assertEqual((self.directory / "state.json").read_bytes(), before)

    def test_changed_driver_facts_and_dependencies_create_new_generations(self):
        first = self.generation()
        before = {p.relative_to(first): p.read_bytes() for p in first.rglob("*") if p.is_file()}
        (self.source / "driver.py").write_text("# updated driver\n")
        second = self.generation()
        self.assertNotEqual(first, second)
        third = self.generation("--fact", "domain_id=7")
        self.assertNotEqual(second, third)
        data = kb.read_yaml(self.source / "bundle.yaml")
        data["pins"]["apt"].append("another-driver")
        kb.write_yaml(self.source / "bundle.yaml", data)
        fourth = self.generation("--fact", "domain_id=7")
        self.assertNotEqual(third, fourth)
        self.assertEqual(before, {p.relative_to(first): p.read_bytes() for p in first.rglob("*") if p.is_file()})
        self.assertEqual(self.generation("--fact", "domain_id=7"), fourth)

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

    def test_invalid_generated_python_and_urdf_never_finalize(self):
        for artifact in ("driver.py", "model.urdf"):
            with self.subTest(artifact=artifact):
                def invalid(bundle, facts, state):
                    (bundle.directory / "model.urdf").write_text('<robot name="valid"/>')
                    (bundle.directory / artifact).write_text("this is invalid syntax ???")
                code, result = self.run_provision("--reset", steps={"invalid": invalid})
                self.assertEqual(code, 1, result)
                self.assertFalse((self.directory / "ros/generations").exists())

    def test_resume_preserves_completed_vendor_artifacts(self):
        calls = []
        def vendor(bundle, facts, state):
            calls.append("vendor")
            (bundle.directory / "driver.py").write_text("# generated by vendor\n")
            (bundle.directory / "model.urdf").write_text('<robot name="generated"/>')
        steps = {"vendor": vendor}
        with patch.object(kb, "write_scripts", side_effect=OSError("interrupted render")):
            code, result = self.run_provision(steps=steps)
        self.assertEqual(code, 1, result)
        self.assertTrue(kb.State(self.directory).done("vendor"))
        generation = self.generation(steps=steps)
        self.assertEqual(calls, ["vendor"])
        self.assertEqual((generation / "driver.py").read_text(), "# generated by vendor\n")
        self.assertEqual((generation / "model.urdf").read_text(), '<robot name="generated"/>')

    def test_completed_rename_is_reconciled_after_interrupted_receipt(self):
        generation = self.generation()
        state = kb.State(self.directory)
        state.data["attempt"]["complete"] = False
        state.save()
        self.assertEqual(self.generation(), generation)
        self.assertTrue(kb.State(self.directory).data["attempt"]["complete"])

    def test_missing_yaml_is_actionable_without_writing_state(self):
        with patch.object(bundle_manifest, "_yaml", side_effect=kb.MissingYaml("PyYAML is required")):
            code, result = self.run_provision()
        self.assertEqual(code, 2)
        self.assertEqual(result["needs"][0]["packages"], ["python3-yaml"])
        self.assertFalse(self.directory.exists())

    def test_invalid_ros_configuration_rejects_before_writes(self):
        for fact in ("domain_id=233", "namespace=bad namespace"):
            code, result = self.run_provision("--fact", fact)
            self.assertEqual(code, 1, result)
            self.assertFalse(self.directory.exists())

    def test_concurrent_provisioning_reuses_one_complete_generation(self):
        args = [sys.executable, str(self.source / "provision.py"), "--dir", str(self.directory), *LIBRARIES]
        for fact in ("name=left", "robot_ip=10.0.0.1", "arm_type=demo5", "ros_distro=jazzy", "use_mock_hardware=true"):
            args += ["--fact", fact]
        env = {**os.environ, "PYTHONPATH": os.pathsep.join(map(str, (LIBRARY, CORE_LIBRARY)))}
        processes = [subprocess.Popen(args, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for _ in range(2)]
        results = []
        for process in processes:
            stdout, stderr = process.communicate(timeout=20)
            self.assertEqual(process.returncode, 0, stderr + stdout)
            results.append(json.loads(stdout)["generations"])
        self.assertEqual(results[0], results[1])


class SatelliteTests(GenerationFixture):
    def setUp(self):
        super().setUp()
        self.child = self.source.parent / "demo-imu"
        self.child.mkdir()
        kb.write_yaml(self.child / "bundle.yaml", {"version": 1, "name": "demo-imu", "device": {"type": "imu"}, "facts": []})
        (self.child / "driver.py").write_text("# shipped driver v1\n")
        (self.child / "DEVICE.md").write_text("Shared guide\n")

    def satellites(self, names):
        data = kb.read_yaml(self.source / "bundle.yaml")
        data["satellites"] = [{"bundle": "demo-imu", "name": name} for name in names]
        kb.write_yaml(self.source / "bundle.yaml", data)

    def test_all_destinations_checked_before_any_write(self):
        for collision in ("self", "duplicate", "unowned", "other_parent", "other_bundle"):
            with self.subTest(collision=collision):
                second = "${name}" if collision == "self" else "first" if collision == "duplicate" else "existing"
                self.satellites(["first", second])
                existing = self.directory.parent / "existing"
                if existing.exists():
                    shutil.rmtree(existing)
                if second == "existing":
                    existing.mkdir(parents=True)
                    (existing / "driver.py").write_text("# user driver\n")
                    if collision != "unowned":
                        kb.State(existing, bundle="other" if collision == "other_bundle" else "demo-imu", parent="other" if collision == "other_parent" else "left").save()
                before = {p: p.read_bytes() for p in self.directory.parent.rglob("*") if p.is_file()}
                code, result = self.run_provision()
                self.assertEqual(code, 1, result)
                self.assertEqual(before, {p: p.read_bytes() for p in self.directory.parent.rglob("*") if p.is_file()})
                self.assertFalse(self.directory.exists())

    def test_satellite_cannot_finalize_without_a_parent_generation(self):
        data = kb.read_yaml(self.source / "bundle.yaml")
        data["parent"] = "other-parent"
        kb.write_yaml(self.source / "bundle.yaml", data)
        code, result = self.run_provision()
        self.assertEqual(code, 1, result)
        self.assertIn("parent", result["error"])
        self.assertFalse(self.directory.exists())

    def test_child_is_pinned_to_renamed_parent_generation_and_refreshes(self):
        self.satellites(["${name}-imu"])
        code, result = self.run_provision()
        self.assertEqual(code, 0, result)
        parent = Path(result["generations"]["left"])
        child = Path(result["generations"]["left-imu"])
        self.assertIn(quote(str(parent / "ros-python")), (child / "ros-python").read_text())
        self.assertIn(quote(str(parent / "stack.sh")), (child / "stack.sh").read_text())
        root = self.directory.parent / "left-imu"
        (root / "DEVICE.md").write_text("user guide")
        (self.child / "driver.py").write_text("# v2\n")
        code, result = self.run_provision()
        self.assertEqual(code, 0, result)
        updated = Path(result["generations"]["left-imu"])
        self.assertNotEqual(child, updated)
        self.assertEqual((updated / "driver.py").read_text(), "# v2\n")
        self.assertEqual((root / "DEVICE.md").read_text(), "user guide")
        self.assertFalse((updated / "DEVICE.md").exists())
        (self.directory / "env.sh").write_text("export PARENT_ENV=present\n")
        probe = subprocess.run([str(updated / "ros-python"), "-c", "import os; print(os.environ['PARENT_ENV'])"], capture_output=True, text=True)
        self.assertEqual(probe.returncode, 0, probe.stderr)
        self.assertEqual(probe.stdout.strip(), "present")


class ProfileShapeTests(unittest.TestCase):
    def test_non_ros_bundle_uses_verbatim_connection_and_no_extrinsics_for_models(self):
        with tempfile.TemporaryDirectory() as temporary:
            data = {"version": 1, "name": "demo-model", "device": {"type": "model"},
                    "facts": [{"key": "compute", "type": "string", "default": "cuda:0"}],
                    "driver": {"actions": ["load", "unload", "status", "read", "infer"], "timeout_s": 600},
                    "profile": {"access": {"connection": {"kind": "process", "compute": {"kind": "cuda", "index": 0}},
                                           "driver": {"interpreter": "${ros_root}/venv/bin/python"}},
                                "intrinsics": {"family": "demo", "device": "${compute}"}}}
            (Path(temporary) / "bundle.yaml").write_text(yaml.safe_dump(data))
            bundle = kb.load(temporary)
            facts = kb.validate_facts(bundle, {})
            with patch.dict(os.environ, {"KINEX_BUNDLE_ROS_ROOT": "/opt/ros"}):
                profile = kb.render_profile(bundle, facts)
            self.assertEqual(profile["access"]["connection"], {"kind": "process", "compute": {"kind": "cuda", "index": 0}})
            self.assertEqual(profile["access"]["driver"], {"entry": "driver.py", "interpreter": "/opt/ros/venv/bin/python",
                                                           "actions": ["load", "unload", "status", "read", "infer"], "persistent": True, "timeout_s": 600})
            self.assertEqual(profile["intrinsics"], {"source": "default", "family": "demo", "device": "cuda:0"})
            self.assertNotIn("extrinsics", profile)
            self.assertIsNone(kb.render_robot(bundle, facts))
            self.assertIsNone(kb.render_recipe(bundle, facts))
            names = kb.write_scripts(bundle, facts, "/lib")
            self.assertEqual(names, ["ros-python", "check.sh"])
            wrapper = (Path(temporary) / "ros-python").read_text()
            self.assertNotIn("source '", wrapper)
            self.assertNotIn("ROS_DOMAIN_ID", wrapper)
            self.assertNotIn("RMW_IMPLEMENTATION", wrapper)

    def test_camera_connection_topics(self):
        data = {"version": 1, "name": "cam", "device": {"type": "rgbd"}, "facts": [{"key": "domain_id", "type": "int", "default": 3}],
                "driver": {"color_topic": "/cam/color", "depth_topic": "/cam/depth", "camera_info_topic": "/cam/info"}}
        bundle = kb.Bundle("/nowhere", kb.validate_manifest(data), {})
        connection = kb.render_profile(bundle, {"domain_id": 3})["access"]["connection"]
        self.assertEqual(connection, {"kind": "ros", "color_topic": "/cam/color", "depth_topic": "/cam/depth"})
        self.assertEqual(kb.render_profile(bundle, {"domain_id": 3})["access"]["driver"]["actions"],
                         ["read", "load", "unload", "status", "introspect", "record_start", "record_stop"])


if __name__ == "__main__":
    unittest.main()

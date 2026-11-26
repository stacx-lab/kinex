"""Calibration runs, sampling and the rigid, TCP, bias and base solvers against fake profiles and devices."""
import asyncio
import copy
import json
import math
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np

import kinex
from kinex.common import urdf
from kinex.communication import ambient
from kinex.device import Device
from kinex.lib import calibration
from kinex.lib.calibration import base, rigid, sensor, tcp

ROOT = {"parent": None, "translation_m": None, "rotation_xyzw": None}
ARM = """<robot name="arm"><link name="base_link"/><link name="link"/><link name="flange"/>
<joint name="j" type="revolute"><parent link="base_link"/><child link="link"/><axis xyz="0 0 1"/><limit lower="-1" upper="1"/></joint>
<joint name="flange_joint" type="fixed"><parent link="link"/><child link="flange"/><origin xyz="1 0 0"/></joint></robot>"""


def merge(profile, patch):
    """profile_write's deep merge: mappings merge, everything else replaces."""
    for key, value in patch.items():
        profile[key] = merge(profile[key], value) if isinstance(value, dict) and isinstance(profile.get(key), dict) else value
    return profile


class Workspace(unittest.TestCase):
    """A temporary .kinex with profiles the solvers read through kinex.device(name).profile."""

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.profiles = {}
        for active in (patch.dict(os.environ, {"KINEX_WORKSPACE": str(self.root / ".kinex")}),
                       patch.object(Device, "profile", property(lambda device: copy.deepcopy(self.profiles[device.name])))):
            active.start()
            self.addCleanup(active.stop)
        self.enterContext(ambient(SimpleNamespace(catalog={})))  # kinex.device names a device within a program

    def device(self, name, type, **fields):
        self.profiles[name] = {"name": name, "type": type, "frames": {"base": ROOT}, "runtime": {"nodes": []}, "operations": {}, **fields}

    def joint(self, name, xml=ARM, tips=("flange",)):
        file = self.root / f"{name}.urdf"
        file.write_text(xml)
        self.device(name, "joint", model={"format": "urdf", "path": str(file), "base_link": "base_link", "tip_links": list(tips)},
                    resolved_model=urdf.read_tree(file, "base_link"),
                    operations={"joint_state": {"direction": "output", "type": "sensor_msgs/msg/JointState"}})

    def apply(self, result):
        proposed = dict(result["proposed"])
        merge(self.profiles[proposed.pop("name")], proposed)

    def record(self, run, samples):
        (run.directory / "samples.json").write_text(json.dumps([{"index": index, **sample} for index, sample in enumerate(samples)]))


class Message(SimpleNamespace):
    """A ROS-like message that kinex.plain converts field by field."""

    def get_fields_and_field_types(self):
        return dict.fromkeys(vars(self), "")


class Time(Message):
    pass


Time.__module__ = "builtin_interfaces.msg"


def stamp(seconds):
    return Time(sec=int(seconds), nanosec=round(seconds % 1 * 1e9))


def joint_state(position, velocity, seconds):
    return Message(header=Message(stamp=stamp(seconds), frame_id=""), name=["j"], position=[position], velocity=[velocity], effort=[])


class Stream:
    """A subscription delivering its messages in order and then repeating the last."""

    closed = False

    def __init__(self, messages):
        self.messages = list(messages)

    def close(self):
        pass

    @property
    def latest(self):
        return self.messages.pop(0) if len(self.messages) > 1 else self.messages[0]

    async def next(self, *, timeout_s=None):
        if not self.messages:
            raise TimeoutError
        return self.latest


def devices(topics):
    """kinex.device over a scope whose output topics deliver these messages."""
    from kinex.device import Device
    catalog = {name: {"timeout_s": 1, "direction": "output", "messages": messages} for name, messages in topics.items()}
    scope = SimpleNamespace(catalog=catalog, topics={}, operation=lambda reference, transport=None: catalog[reference],
                            subscribe=lambda spec, depth: Stream(spec["messages"]))
    return patch.object(kinex, "device", lambda name: Device(scope, name))


class Runs(Workspace):
    def test_runs_keep_their_bindings_and_reject_unbound_devices(self):
        run = calibration.start("calibrate-tcp-offset", arm="arm", target="tool")
        self.assertEqual(calibration.resume(run.id).bindings, {"arm": "arm", "target": "tool"})
        self.assertTrue((self.root / ".kinex/calib" / run.id / "manifest.json").is_file())
        with self.assertRaisesRegex(ValueError, "binds no parent"):
            run.role("parent")
        with self.assertRaisesRegex(ValueError, "unknown calibration run"):
            calibration.resume("missing")
        with self.assertRaisesRegex(ValueError, "not bound"):
            asyncio.run(run.sample("other"))
        with patch.dict(os.environ, {"KINEX_WORKSPACE": ""}), self.assertRaisesRegex(RuntimeError, "inside exec"):
            calibration.start("calibrate-tcp-offset")

    def test_sampling_settles_joint_devices_and_stores_link_poses(self):
        self.joint("arm")
        run = calibration.start("calibrate-tcp-offset", arm="arm")
        moving = [joint_state(.35, .1, 1), *(joint_state(.35, 0, t) for t in (2, 3, 4))]
        with patch.object(calibration, "SETTLE_INTERVAL_S", 0), devices({"arm.joint_state": moving}):
            sample = asyncio.run(run.sample("arm", frame="flange", settle=True, stable_reads=2))
        self.assertTrue(sample["settled"])
        self.assertEqual(sample["data"]["header"]["stamp"], 3)
        expected = [math.cos(.35), math.sin(.35), 0, 0, 0, math.sin(.175), math.cos(.175)]
        np.testing.assert_allclose(sample["kinematics"]["pose"], expected, atol=1e-9)
        # A cached reading repeats its stamp, so it never establishes rest.
        with patch.object(calibration, "SETTLE_INTERVAL_S", 0), devices({"arm.joint_state": [joint_state(.35, 0, 5)]}):
            cached = asyncio.run(run.sample("arm", settle=True, stable_reads=2, timeout_s=.05, note="cached"))
        self.assertEqual((cached["settled"], cached["index"], cached["note"], "kinematics" in cached), (False, 1, "cached", False))
        self.assertEqual([item["index"] for item in run.samples("arm")], [0, 1])
        # A profile without runtime or operations still samples a named operation.
        del self.profiles["arm"]["runtime"], self.profiles["arm"]["operations"]
        with devices({"arm.joint_state": [joint_state(.35, 0, 6)]}):
            self.assertEqual(asyncio.run(run.sample("arm", "joint_state"))["index"], 2)
        with self.assertRaisesRegex(ValueError, "name the operation"):
            asyncio.run(run.sample("arm"))
        with self.assertRaisesRegex(ValueError, "must name a URDF link of joint device arm"):
            asyncio.run(run.sample("arm", frame="missing"))

    def test_camera_samples_archive_each_stream_before_appending(self):
        def image(encoding, step, seconds=1):
            return SimpleNamespace(header=SimpleNamespace(stamp=stamp(seconds), frame_id="camera/color"), encoding=encoding,
                                   height=1, width=1, step=step, data=bytes(step), is_bigendian=0)
        self.device("camera", "rgbd")
        run = calibration.start("calibrate-camera-intrinsics", target="camera")
        with devices({"camera.image": [image("rgb8", 3)], "camera.depth": [image("16UC1", 2)]}):
            sample = asyncio.run(run.sample("camera"))
        self.assertEqual(set(sample["files"]), {"color", "depth"})
        for file in sample["files"].values():
            self.assertEqual(Path(file).parent, run.directory / "artifacts")
        with self.assertRaisesRegex(ValueError, "no velocity feedback"):
            asyncio.run(run.sample("camera", settle=True))
        with devices({"camera.image": [image("bogus", 3)], "camera.depth": [image("16UC1", 2)]}), self.assertRaises(ValueError):
            asyncio.run(run.sample("camera"))
        self.assertEqual(len(run.samples()), 1)


class Solvers(Workspace):
    def test_survey_fits_a_known_mount_and_archives_its_points(self):
        self.device("arm", "joint")
        self.device("base", "locomotion")
        run = calibration.start("calibrate-fixed-arm-mount", target="arm", parent="base")
        points = [[0, 0, 0], [.1, 0, 0], [0, .1, 0], [0, 0, .1], [.2, .1, .3]]
        result = rigid.fit_mount(run, points, [[.2 - y, .3 + x, .4 + z] for x, y, z in points], "base")
        self.assertEqual(result["quality"], "passed")
        mount = result["proposed"]["frames"]["base"]
        np.testing.assert_allclose(mount["translation_m"], [.2, .3, .4], atol=1e-8)
        self.assertEqual(mount["parent"], "base:base")
        self.assertTrue((self.root / ".kinex" / result["evidence"]).is_file())
        self.assertEqual(len(json.loads(next(run.directory.glob("fit-mount-points-*.json")).read_text())["source_m"]), 5)
        self.assertEqual(self.profiles["arm"]["frames"]["base"], ROOT)

        line = [[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0]]
        degenerate = rigid.fit_mount(run, line, line, "base")
        self.assertEqual((degenerate["computation"], degenerate["quality"], degenerate["proposed"]), ("succeeded", "failed", None))
        self.assertTrue(degenerate["data"]["degenerate"])
        self.assertNotEqual(degenerate["evidence"], result["evidence"])

    def test_base_checks_require_tolerances_units_references_and_fresh_timestamps(self):
        run = calibration.start("verify-base-interface", base="base")
        check = {"name": "vx", "expected": .1, "measured": .105, "tolerance": .01, "units": "m/s",
                 "reference": "tracked displacement / measured elapsed time", "timestamps": [1, 2]}
        passed = base.verify(run, ["vx"], [check])
        self.assertEqual((passed["quality"], passed["data"]["coverage"], passed["proposed"]), ("passed", ["vx"], None))
        for bad in ({"tolerance"}, {"units"}):
            self.assertEqual(base.verify(run, ["vx"], [{key: value for key, value in check.items() if key not in bad}])["quality"], "failed")
        for bad in ({"reference": ""}, {"timestamps": [1, 1]}, {"measured": .2}):
            self.assertEqual(base.verify(run, ["vx"], [{**check, **bad}])["quality"], "failed")
        self.assertEqual(base.verify(run, ["vx", "expiry"], [check])["quality"], "failed")
        exact = base.verify(run, ["units"], [{"name": "units", "expected": "normalized", "measured": "normalized", "reference": "SDK metadata"}])
        self.assertEqual(exact["quality"], "passed")

    def test_tcp_fit_resolves_translation_only(self):
        self.device("arm", "joint")
        self.device("tool", "gripper", frames={"tcp": {"parent": "tool:base", "translation_m": "???", "rotation_xyzw": [0, 0, 0, 1]},
                                               "base": {"parent": "arm:flange", "translation_m": [0, 0, .02], "rotation_xyzw": [0, 0, 1, 0]}})
        s = math.sqrt(.5)
        samples = []
        for x, y, z, w in [[0, 0, 0, 1], [s, 0, 0, s], [0, s, 0, s], [0, 0, s, s], [-s, 0, 0, s], [0, -s, 0, s]]:
            rotated = [2 * (x * z + w * y) * .12, 2 * (y * z - w * x) * .12, (1 - 2 * (x * x + y * y)) * .12]
            samples.append({"device": "arm", "settled": True, "kinematics": {"frame": "flange", "pose": [.2 - rotated[0], .1 - rotated[1], .5 - rotated[2], x, y, z, w]}})
        run = calibration.start("calibrate-tcp-offset", arm="arm", target="tool")
        self.record(run, samples)
        result = tcp.fit(run, "flange")
        self.assertEqual(result["quality"], "passed", result["data"])
        edge = result["proposed"]["frames"]["tcp"]
        self.assertAlmostEqual(edge["translation_m"][2], .10, places=8)
        self.assertEqual(edge["rotation_xyzw"], [0, 0, 0, 1])
        self.assertEqual([fact["pointer"] for fact in result["resolved"]], ["/frames/tcp/translation_m"])
        self.assertTrue(result["unresolved"])
        self.profiles["tool"]["frames"]["tcp"]["rotation_xyzw"] = "???"
        self.assertEqual(tcp.fit(run, "flange")["proposed"]["frames"]["tcp"]["rotation_xyzw"], "???")
        self.record(run, samples[:3])
        self.assertEqual(tcp.fit(run, "flange")["computation"], "failed")
        self.profiles["tool"]["frames"]["base"]["translation_m"] = "???"
        with self.assertRaisesRegex(ValueError, "known mount"):
            tcp.fit(run, "flange")

    def test_sensor_bias_adds_the_mean_static_residual_and_needs_gravity_for_specific_force(self):
        def channel(bias, **extra):
            return {"axes": ["x", "y", "z"], "bias": bias, "range": None, "resolution": None, **extra}
        self.device("imu", "imu", measurement={"angular_velocity": channel({"x": .01, "y": 0, "z": 0}), "orientation": None, "magnetic_field": None,
                                               "linear_acceleration": channel({"x": 0, "y": 0, "z": 0}, quantity="specific_force")})
        run = calibration.start("calibrate-sensor-bias", target="imu")
        self.record(run, [{"device": "imu", "data": {"angular_velocity": {"x": .02, "y": -.01, "z": 0},
                                                     "linear_acceleration": {"x": .1, "y": 0, "z": 9.9}}}] * 20)
        with self.assertRaisesRegex(ValueError, "gravity_m_s2"):
            sensor.bias(run)
        result = sensor.bias(run, gravity_m_s2=[0, 0, 9.80665])
        self.assertEqual(result["quality"], "passed")
        measurement = result["proposed"]["measurement"]
        self.assertAlmostEqual(measurement["angular_velocity"]["bias"]["x"], .03, places=12)
        self.assertAlmostEqual(measurement["linear_acceleration"]["bias"]["z"], 9.9 - 9.80665, places=12)
        self.apply(result)
        self.assertEqual(self.profiles["imu"]["measurement"]["linear_acceleration"]["quantity"], "specific_force")
        self.record(run, run.samples()[:5])
        self.assertEqual(sensor.bias(run, gravity_m_s2=[0, 0, 9.80665])["quality"], "failed")


if __name__ == "__main__":
    unittest.main()

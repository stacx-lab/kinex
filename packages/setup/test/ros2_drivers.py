"""Behavioral tests for ROS adapters, buffers and subprocess cleanup."""

import base64
import io
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image
from kinex_ros.ros2 import BundleError
from kinex_ros.ros2_drivers import CameraSource, ImuSource, JointTrajectoryDriver, TwistDriver
from ros2_fixtures import fixture


class Adapters(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        environment = patch.dict(os.environ, {"KINEX_FAKE_RCLPY_SCENARIO": str(self.directory / "scenario.json"), "ROS_DOMAIN_ID": "0"})
        environment.start()
        self.addCleanup(environment.stop)

    def driver(self, kind="joint"):
        self.manifest, self.profile, self.graph = fixture(self.directory, kind)
        cls = {"joint": JointTrajectoryDriver, "velocity": TwistDriver, "imu": ImuSource, "rgb": CameraSource, "rgbd": CameraSource}[kind]
        driver = cls(self.directory)
        driver.serving = True
        self.addCleanup(lambda: driver.close(stop=False) if kind in ("joint", "velocity") else driver.close())
        return driver

    def wait_for(self, condition, timeout=2):
        deadline = time.monotonic() + timeout
        while not condition():
            self.assertLess(time.monotonic(), deadline)
            time.sleep(.005)

    def test_load_is_read_only_and_reorders_joint_feedback(self):
        driver = self.driver()
        driver.execute("load", {})
        world = driver.handle.session.context.world
        self.assertEqual(world.published, [])
        world.spec["robot"]["positions"] = [.2, .1]
        count = driver.handle.latest.count
        driver.handle.latest.wait(.2, count)
        result = driver.execute("read", {})
        self.assertEqual(result["positions"], [.1, .2])
        self.assertEqual(result["faults"], [])
        self.assertEqual(driver.handle.session.controllers(), {"jtc": "active"})

    def test_failed_load_names_stack_command_and_rolls_back(self):
        driver = self.driver()
        self.graph["topics"] = {}
        (self.directory / "scenario.json").write_text(json.dumps(self.graph))
        result = driver.dispatch("load", {})
        self.assertFalse(result["ok"])
        self.assertIn("stack.sh", result["error"])
        self.assertIn("start and retry /load", result["error"])
        self.assertIsNone(driver.handle)

    def test_short_gap_is_tolerated_and_stale_feedback_faults(self):
        driver = self.driver()
        driver.execute("load", {})
        world = driver.handle.session.context.world
        world.topics["/joint_states"]["stale_after_s"] = 0
        time.sleep(.01)
        with driver.handle.latest.condition:
            driver.handle.latest.received_mono = time.monotonic() - driver.period_s * 2
            self.assertEqual(driver.execute("read", {})["faults"], [])
            driver.handle.latest.received_mono = time.monotonic() - driver.stale_s * 2
            self.assertIn({"code": "joint_states_stale"}, driver.execute("read", {})["faults"])

    def test_motion_uses_buffer_and_stop_holds_without_stopping_stack(self):
        driver = self.driver()
        driver.execute("load", {})
        result = driver.execute("write", {"actions": [[.01, .02], [.03, .04]], "duration_s": .08})
        self.assertIn("execution_id", result)
        self.wait_for(lambda: driver.buffer.pending is None)
        world = driver.handle.session.context.world
        messages = [message for topic, message in world.published if topic == "/jtc/joint_trajectory"]
        self.assertGreater(len(messages), 1)
        self.assertEqual(messages[-1]["points"][0]["positions"], [.03, .04])
        self.wait_for(lambda: all(abs(a - b) < .001 for a, b in zip(driver.execute("read", {})["positions"], [.03, .04])))
        owned = driver.handle.action
        owned.send(owned.type.Goal())
        driver.execute("stop", {})
        self.assertEqual(world.published[-1][1], {"cancel": True})
        self.assertEqual(world.published[-2][1]["points"][0]["velocities"], [0., 0.])
        self.assertFalse(owned.handles)
        self.assertTrue(driver.handle.session.context.ok())

    def test_stop_replaces_unfinished_trajectory_with_measured_hold(self):
        driver = self.driver()
        driver.execute("load", {})
        driver.execute("write", {"actions": [[.5, .5]], "duration_s": 1})
        self.wait_for(lambda: driver.execute("read", {})["positions"][0] > .02)
        driver.execute("stop", {})
        world = driver.handle.session.context.world
        hold = world.published[-1][1]["points"][0]
        self.assertLess(max(hold["positions"]), .4)
        self.assertEqual(hold["time_from_start"], {"sec": 0, "nanosec": 0})
        self.assertEqual(hold["velocities"], [0., 0.])
        self.assertEqual(hold["accelerations"], [0., 0.])
        time.sleep(.1)
        self.assertIsNone(driver.buffer.pending)
        for actual, held in zip(driver.execute("read", {})["positions"], hold["positions"]):
            self.assertAlmostEqual(actual, held, delta=.001)

    def test_failed_stop_blocks_new_writes_until_reconnection(self):
        for kind in ("joint", "velocity"):
            with self.subTest(kind=kind):
                driver = self.driver(kind)
                driver.execute("load", {})
                topic = driver.state_topic
                world = driver.handle.session.context.world
                world.topics[topic]["stale_after_s"] = 0
                time.sleep(.01)
                self.assertFalse(driver.dispatch("stop", {})["ok"])
                del world.topics[topic]["stale_after_s"]
                driver.handle.latest.wait(.2, driver.handle.latest.count)
                self.assertIn({"code": "stop_failed"}, driver.execute("read", {})["faults"])
                args = {"actions": [[.01, .02]], "duration_s": .02} if kind == "joint" else {"mode": "drive", "velocity": {"vx": .1, "vy": 0., "wz": 0.}, "duration_s": .02}
                self.assertEqual(driver.dispatch("write", args)["code"], "stop_failed")
                driver.execute("stop", {})
                self.assertEqual(driver.dispatch("write", args)["code"], "stop_failed")
                driver.execute("unload", {})
                driver.execute("load", {})
                self.assertTrue(driver.dispatch("write", args)["ok"])
                driver.execute("unload", {})

    def test_velocity_expires_to_zero_and_preserves_feedback_order(self):
        driver = self.driver("velocity")
        driver.execute("load", {})
        driver.execute("write", {"mode": "drive", "velocity": {"vx": .1, "vy": .2, "wz": .3}, "duration_s": .06})
        self.wait_for(lambda: driver.execute("read", {})["velocities"] == [.1, .2, .3])
        self.wait_for(lambda: driver.buffer.pending is None)
        self.wait_for(lambda: driver.execute("read", {})["velocities"] == [0., 0., 0.])
        self.assertNotIn("pose", driver.execute("read", {}))
        messages = driver.handle.session.context.world.published
        self.assertGreaterEqual(len(messages), 3)
        self.assertEqual(messages[-1][1]["linear"], {"x": 0., "y": 0., "z": 0.})

    def test_imu_has_si_channels_and_does_not_subtract_bias(self):
        driver = self.driver("imu")
        driver.execute("load", {})
        state = driver.execute("read", {})
        self.assertEqual(state["angular_velocity"]["x"], .2)
        self.assertEqual(state["linear_acceleration"]["z"], 9.81)
        self.assertEqual(state["orientation"], [0., 0., 0., 1.])
        self.assertIsNone(state["magnetic_field"])
        driver.handle.session.context.world.topics["/imu"]["message"]["orientation_covariance"][0] = -1
        driver.handle.latest.wait(.2, driver.handle.latest.count)
        with self.assertRaisesRegex(BundleError, "unavailable"):
            driver.execute("read", {})

    def test_rgbd_stride_endianness_range_filter_and_png(self):
        driver = self.driver("rgbd")
        driver.execute("load", {})
        sample = driver.grab(driver.handle)
        self.assertEqual(sample["color"].tolist(), [[[10, 20, 30], [40, 50, 60]]])
        self.assertEqual(sample["depth"].tolist(), [[1000, 0]])
        self.assertEqual(sample["depth"].dtype, np.uint16)
        self.assertTrue(sample["color"].flags.owndata)
        result = driver.execute("read", {"output": "base64"})
        with Image.open(io.BytesIO(base64.b64decode(result["color"]))) as image:
            self.assertEqual(image.getpixel((0, 0)), (10, 20, 30))
        patch = driver.introspect()["intrinsics"]["color"]
        self.assertEqual(patch["projection"]["fx"], 100.)

    def test_camera_rejects_unsynchronized_or_stale_samples(self):
        driver = self.driver("rgbd")
        driver.execute("load", {})
        for topic in ("/color", "/depth"):
            driver.handle.session.context.world.topics[topic]["stale_after_s"] = 0
        time.sleep(.01)
        driver.handle.streams["depth"].stamp_s -= 1
        with self.assertRaisesRegex(BundleError, "synchronized"):
            driver.grab(driver.handle)
        driver.handle.streams["color"].received_mono -= 1
        with self.assertRaisesRegex(BundleError, "fresh"):
            driver.grab(driver.handle)

    def test_camera_recording_reuses_one_stream_and_unload_stops_capture(self):
        driver = self.driver("rgbd")
        driver.execute("load", {})
        handle = driver.handle
        from kinex.stream import VideoRecorder
        with patch.object(VideoRecorder, "_open"), patch.object(VideoRecorder, "_sink"), patch.object(VideoRecorder, "_close"):
            driver.execute("record_start", {"dir": str(self.directory / "capture"), "rate_hz": 100})
            recorder = driver.recorder
            self.wait_for(lambda: recorder.count > 1)
            self.assertIn("color", driver.execute("read", {"output": "base64"}))
            self.assertIs(driver.handle, handle)
            driver.execute("unload", {})
            self.assertFalse(recorder.running)
            self.assertIsNone(driver.handle)
            self.assertIsNone(handle.session.context)

    def test_subprocess_eof_sends_hold_or_zero_before_exit(self):
        for kind in ("joint", "velocity"):
            with self.subTest(kind=kind):
                _, _, _ = fixture(self.directory, kind)
                log = self.directory / f"{kind}-published.jsonl"
                env = {**os.environ, "KINEX_FAKE_RCLPY_LOG": str(log)}
                process = subprocess.Popen([sys.executable, str(self.directory / "driver.py"), "--serve"], stdin=subprocess.PIPE,
                                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
                try:
                    process.stdin.write(json.dumps({"id": "load", "action": "load", "args": {}}) + "\n")
                    process.stdin.flush()
                    replies = queue.Queue()
                    threading.Thread(target=lambda: [replies.put(json.loads(line)) for line in process.stdout], daemon=True).start()
                    self.assertTrue(replies.get(timeout=3)["ok"])
                    process.stdin.close()
                    process.wait(timeout=5)
                    self.assertEqual(process.returncode, 0, process.stderr.read())
                    last = json.loads(log.read_text().splitlines()[-1])["message"]
                    if kind == "joint":
                        self.assertEqual(last["points"][0]["positions"], [0., 0.])
                        self.assertEqual(last["points"][0]["velocities"], [0., 0.])
                    else:
                        self.assertEqual(last["linear"]["x"], 0.)
                finally:
                    if process.poll() is None:
                        process.kill()
                        process.wait()
                    process.stdout.close()
                    process.stderr.close()


if __name__ == "__main__":
    unittest.main()

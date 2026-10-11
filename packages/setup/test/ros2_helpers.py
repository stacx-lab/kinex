"""Transport and failure-path checks against a scripted, hardware-free ROS graph."""

import hashlib
from concurrent.futures import Future
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from kinex_ros.ros2 import (BundleError, Latest, Session, StopConfirm, StopNotConfirmed,
                        camera_info_patch, joint_state_vector, jtc_hold, jtc_point,
                        message_class, stamp_seconds, twist, zero_twist)


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

    def test_timestamp_policy(self):
        self.assertEqual(stamp_seconds(10, 100000000, 10.2, .5), 10.1)
        self.assertEqual(stamp_seconds(1, 0, 10, .5), 10)
        self.assertEqual(stamp_seconds(0, 0, 10, .5), 10)
        self.assertEqual(stamp_seconds(10, 0, 10, .5, 11), 11)
        cache = Latest("/state")
        message = message_class("sensor_msgs/msg/JointState")()
        with patch("kinex_ros.ros2.time.time", side_effect=[10., 9.]):
            cache.update(message)
            cache.update(message)
        self.assertEqual(cache.stamp_s, 10)
        self.assertEqual(cache.regressions, 1)

    def test_cached_samples_do_not_become_fresh_on_read(self):
        cache = Latest("/state")
        cache.update(object())
        stamp = cache.stamp_s
        self.assertEqual(cache.count, 1)
        self.assertEqual(cache.stamp_s, stamp)
        with patch("kinex_ros.ros2.time.monotonic", return_value=cache.received_mono + .01):
            with self.assertRaisesRegex(BundleError, "fresh"):
                cache.get(.001)
            self.assertEqual(cache.rate_hz(.005), 0)

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

    def test_joint_order_and_invalid_feedback(self):
        cls = message_class("sensor_msgs/msg/JointState")
        message = cls(name=["b", "a"], position=[2., 1.], velocity=[.2, .1])
        self.assertEqual(joint_state_vector(message, ["a", "b"]), {"positions": [1., 2.], "velocities": [.1, .2], "efforts": None})
        for bad in (cls(name=["a", "a"], position=[1., 1.]), cls(name=["a", "b"], position=[math.nan, 0.]), cls(name=["a", "b"], position=[0.])):
            with self.assertRaises(BundleError):
                joint_state_vector(bad, ["a", "b"])

    def test_builders(self):
        message = jtc_point(["a"], [.4], 1.25)
        self.assertEqual(message.points[0].time_from_start.sec, 1)
        self.assertEqual(message.points[0].time_from_start.nanosec, 250000000)
        hold = jtc_hold(["a"], [.2]).points[0]
        self.assertEqual((hold.positions, hold.velocities, hold.accelerations), ([.2], [0.], [0.]))
        self.assertEqual((hold.time_from_start.sec, hold.time_from_start.nanosec), (0, 0))
        message = twist([.2, 0., 0.], [0., 0., .1], "geometry_msgs/msg/TwistStamped", 12.5)
        self.assertEqual(message.twist.linear.x, .2)
        self.assertEqual(message.header.stamp.sec, 12)
        self.assertEqual(zero_twist().angular.z, 0)

    def test_graph_and_subscribers(self):
        session = self.session({"topics": {"/cmd_vel": {"type": "geometry_msgs/msg/TwistStamped", "subscribers": 1}}})
        self.assertEqual(session.resolve_type("/cmd_vel", ["geometry_msgs/msg/Twist", "geometry_msgs/msg/TwistStamped"]), "geometry_msgs/msg/TwistStamped")
        session.wait_topics(["/cmd_vel"], .01)
        with self.assertRaises(BundleError):
            session.wait_topics(["/missing"], .01)
        publisher = session.publisher("/cmd_vel", "geometry_msgs/msg/TwistStamped")
        publisher.publish_repeat(zero_twist("geometry_msgs/msg/TwistStamped"), 3, .001)
        self.assertEqual(len(session.context.world.published), 3)
        self.assertEqual(session.subscriber_count("/cmd_vel"), 1)
        session.context.world.topics["/cmd_vel"]["subscribers"] = 0
        with self.assertRaisesRegex(BundleError, "no subscribers"):
            publisher.publish(zero_twist())

    def test_domain_mismatch_does_not_start_ros(self):
        with self.assertRaisesRegex(BundleError, "ROS_DOMAIN_ID"):
            Session(domain_id=8).open()

    def test_description_topic_and_parameter_fallback(self):
        session = self.session({"topics": {"/robot_description": {"type": "std_msgs/msg/String", "latched": True, "message": {"data": "<robot/>"}}}})
        self.assertEqual(session.robot_description(timeout_s=.1), "<robot/>")
        session.close()
        session = self.session({"parameters": {"/robot_state_publisher": {"robot_description": "<robot name='fallback'/>"}}})
        self.assertIn("fallback", session.robot_description(timeout_s=.1))

    def test_expect_diff_and_rate_shortfall(self):
        session = self.session({"topics": {
            "/joint_states": {"type": "sensor_msgs/msg/JointState", "rate_hz": 100, "publishers": 2, "message": {"name": ["wrong"], "position": [0.]}},
            "/robot_description": {"type": "std_msgs/msg/String", "latched": True, "message": {"data": "<robot/>"}},
        }, "controllers": {"jtc": "inactive"}})
        expected = {"topics": [{"name": "/missing", "type": "std_msgs/msg/String"}, {"name": "/joint_states", "type": "sensor_msgs/msg/JointState", "min_hz": 1000}],
                    "controllers": [{"name": "jtc", "state": "active"}], "joints": ["a"], "identity": {"single_publisher": "/joint_states"}, "domain": True}
        result = session.expect(expected, {"domain_id": 8}, .05, {"robot_description_sha256": "wrong"})
        failures = {item["name"] for item in result.checks if not item["passed"]}
        self.assertTrue({"topic:/missing", "rate:/joint_states", "controller:jtc", "joints", "single_publisher:/joint_states", "domain", "robot_description_sha256"} <= failures)
        rate = next(item for item in result.checks if item["name"].startswith("rate:"))
        self.assertEqual((rate["expected"], rate["tolerance"], rate["units"]), (0, 0, "Hz"))
        self.assertGreater(rate["timestamps"][1], rate["timestamps"][0])
        self.assertFalse(result.ok)
        self.assertLessEqual(len(result.diff_lines), 20)

    def test_expect_pass_and_check_only_controller_state(self):
        session = self.session({"topics": {"/joint_states": {"type": "sensor_msgs/msg/JointState", "message": {"name": ["a"], "position": [0.]}},
                  "/robot_description": {"type": "std_msgs/msg/String", "latched": True, "message": {"data": "<robot/>"}}},
                  "controllers": {"jtc": "active"}, "frames": {"tool": {"parent": "base"}}})
        result = session.expect({"topics": [{"name": "/joint_states", "type": "sensor_msgs/msg/JointState", "min_hz": 1}], "joints": ["a"], "frames": ["tool", "base"], "domain": True}, {"domain_id": 7}, .05,
                                {"robot_description_sha256": hashlib.sha256(b"<robot/>").hexdigest()})
        self.assertTrue(result.ok, result.diff_lines)
        self.assertTrue(session.switch_controllers(["jtc"]))
        self.assertEqual(session.context.world.published, [])

    def test_owned_contexts_close_independently_and_idempotently(self):
        first, second = self.session(), self.session()
        context = second.context
        first.close()
        first.close()
        self.assertTrue(context.ok())
        second.check()

    def test_observer_failure_is_visible_to_session_users(self):
        session = self.session({"topics": {"/fault": {"type": "std_msgs/msg/String", "message": {"data": "good"}}}})
        cache = session.latest("/fault", "std_msgs/msg/String")
        cache.wait(.1)
        def observe(message, received):
            if message.data == "bad":
                raise ValueError("invalid fault feedback")
        cache.observe(observe)
        session.context.world.topics["/fault"]["message"]["data"] = "bad"
        deadline = time.monotonic() + .2
        while session.failure is None and time.monotonic() < deadline:
            time.sleep(.001)
        with self.assertRaisesRegex(BundleError, "invalid fault feedback"):
            session.check()

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

    def test_action_cancellation_tracks_only_owned_goals(self):
        session = self.session()
        action = session.action("/jtc/follow_joint_trajectory")
        action.send(action.type.Goal())
        action.cancel_all()
        self.assertEqual(action.handles, [])
        self.assertEqual(session.context.world.published[-1][1], {"cancel": True})
        session.close()
        self.assertTrue(action.client.destroyed)

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

    def test_jtc_and_base_models_stop_and_expire(self):
        for kind, command_type, state_type in [("jtc", "trajectory_msgs/msg/JointTrajectory", "sensor_msgs/msg/JointState"), ("cmd_vel", "geometry_msgs/msg/Twist", "nav_msgs/msg/Odometry")]:
            session = self.session({"topics": {"/command": {"type": command_type, "subscribers": 1}, "/state": {"type": state_type, "rate_hz": 200}},
                                    "robot": {"kind": kind, "command_topic": "/command", "state_topic": "/state", "names": ["a"], "command_timeout_s": .02}})
            latest = session.latest("/state", state_type)
            latest.wait(.1)
            publisher = session.publisher("/command", command_type)
            if kind == "jtc":
                publisher.publish(jtc_point(["a"], [.1], .04))
                time.sleep(.015)
                self.assertGreater(latest.get().position[0], 0)
                publisher.publish(message_class(command_type)())
                self.assertEqual(session.context.world.goal, [.1], "empty trajectories must not stop the fake JTC")
                confirm = StopConfirm(latest, lambda msg: msg.velocity, .001, .1)
                publisher.publish(jtc_hold(["a"], list(latest.get().position)))
            else:
                publisher.publish(twist([.1, 0., 0.]))
                latest.wait(.1, latest.count)
                self.assertGreater(latest.get().twist.twist.linear.x, 0)
                confirm = StopConfirm(latest, lambda msg: [msg.twist.twist.linear.x], .001, .1)
            confirm.wait()
            session.close()

    def test_rectified_camera_info_uses_projection_not_raw_calibration(self):
        cls = message_class("sensor_msgs/msg/CameraInfo")
        projection = [450., 0., 310., -45., 0., 460., 230., 0., 0., 0., 1., 0.]
        message = cls(width=640, height=480, k=[500., 0., 320., 0., 500., 240., 0., 0., 1.],
                      p=projection, d=[.1, .2, 0., 0., .3], distortion_model="equidistant")
        result = camera_info_patch(message, "rectified")
        self.assertEqual(result["projection"], {"model": "pinhole", "fx": 450., "fy": 460., "cx": 310., "cy": 230., "skew": 0.})
        self.assertEqual(result["distortion"], {"model": "none"})
        for bad in ([], [0.] * 12, projection[:-1], [float("nan")] + projection[1:],
                    projection[:4] + [1.] + projection[5:], projection[:-1] + [1.]):
            with self.subTest(projection=bad):
                message.p = bad
                with self.assertRaises(BundleError):
                    camera_info_patch(message, "rectified")
        with self.assertRaisesRegex(BundleError, "raw or rectified"):
            camera_info_patch(message, None)

    def test_camera_info_validation(self):
        cls = message_class("sensor_msgs/msg/CameraInfo")
        result = camera_info_patch(cls(width=640, height=480, k=[500., 0., 320., 0., 500., 240., 0., 0., 1.], d=[0.] * 5), "raw")
        self.assertEqual(result["projection"]["fx"], 500)
        self.assertEqual(result["distortion"], {"model": "none"})
        message = cls(width=640, height=480, k=[500., 0., 320., 0., 500., 240., 0., 0., 1.], d=[.1, .2, 0., 0., .3], distortion_model="plumb_bob")
        self.assertEqual(camera_info_patch(message, "raw")["distortion"]["k3"], .3)
        message.distortion_model = "equidistant"
        with self.assertRaisesRegex(BundleError, "rectified"):
            camera_info_patch(message, "raw")
        with self.assertRaises(BundleError):
            camera_info_patch(cls(), "raw")


if __name__ == "__main__":
    unittest.main()

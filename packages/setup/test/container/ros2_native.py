"""Native rclpy smoke gate, intentionally isolated from physical robots.

Uses real DDS discovery, message validation and executor cleanup with a tiny
in-process joint publisher. It does not validate a ros2_control controller.
"""

import os
from pathlib import Path
import tempfile
import threading
import time
import unittest

import rclpy
from rclpy.context import Context
from rclpy.executors import MultiThreadedExecutor
from sensor_msgs.msg import Imu, JointState
from types import SimpleNamespace
from trajectory_msgs.msg import JointTrajectory
from kinex_ros.ros2_drivers import ImuSource, JointTrajectoryDriver
from kinex_ros.ros2_check import check
from kinex_ros.ros2 import ROSError, Latest, jtc_point
from ros2_fixtures import fixture, write


class NativeTransport(unittest.TestCase):
    def test_native_imu_covariance_arrays(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            fixture(directory, "imu")
            driver = ImuSource(directory)
            message = Imu()
            message.orientation.w = 1.
            message.angular_velocity.x = .2
            message.linear_acceleration.z = 9.81
            latest = Latest("/imu")
            latest.update(message)
            handle = SimpleNamespace(latest=latest)
            self.assertEqual(driver.read_sample(handle)["angular_velocity"]["x"], .2)
            message.orientation_covariance[0] = -1.
            with self.assertRaisesRegex(ROSError, "orientation as unavailable"):
                driver.read_sample(handle)

    def test_joint_discovery_read_command_and_cleanup(self):
        self.assertNotIn('KINEX_FAKE_RCLPY_SCENARIO', os.environ)
        context = Context()
        rclpy.init(args=[], context=context, domain_id=0)
        robot = rclpy.create_node('kinex_container_fixture', context=context)
        executor = MultiThreadedExecutor(num_threads=2, context=context)
        executor.add_node(robot)
        publisher = robot.create_publisher(JointState, '/joint_states', 10)
        commands, positions = [], [0., 0.]
        def command(message):
            commands.append(message)
            if message.points:
                positions[:] = [message.points[-1].positions[list(message.joint_names).index(name)] for name in ['b', 'a']]
        robot.create_subscription(JointTrajectory, '/jtc/joint_trajectory', command, 10)
        def feedback():
            message = JointState()
            message.header.stamp = robot.get_clock().now().to_msg()
            message.name, message.position = ['b', 'a'], list(positions)
            message.velocity, message.effort = [0., 0.], [0., 0.]
            publisher.publish(message)
        robot.create_timer(.01, feedback)
        thread = threading.Thread(target=executor.spin, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary)
                manifest, _, _ = fixture(directory)
                manifest.pop('action')
                manifest.pop('controller')
                manifest['connect_timeout_s'] = 5
                manifest['stop']['confirm']['timeout_s'] = 1
                manifest['expected']['controllers'] = []
                manifest['ready_timeout_s'] = 5
                write(directory / 'profile_ros.yaml', manifest)
                driver = JointTrajectoryDriver(directory)
                driver.serving = True
                try:
                    driver.execute('load', {})
                    self.assertFalse(commands, 'load must not publish motion')
                    # Native generated ROS classes require floats even when
                    # the public command supplies an integral numeric target.
                    self.assertEqual(jtc_point(['a'], [0], .02).points[0].positions[0], 0.)
                    driver.handle.session.action('/unused_goal')
                    driver.execute('write', {'actions': [[.01, .02]], 'duration_s': .1})
                    deadline = time.monotonic() + 3
                    while driver.execute('read', {})['positions'] != [.01, .02]:
                        self.assertLess(time.monotonic(), deadline)
                        time.sleep(.01)
                    driver.execute('stop', {})
                    # Native DDS discovery needs the normal observation window.
                    _, failures = check(directory)
                    self.assertFalse(failures)
                finally:
                    driver.close()
                hold = commands[-1].points[0]
                self.assertEqual(list(hold.positions), [.01, .02])
                self.assertEqual(list(hold.velocities), [0., 0.])
                self.assertEqual(list(hold.accelerations), [0., 0.])
                self.assertEqual((hold.time_from_start.sec, hold.time_from_start.nanosec), (0, 0))
                self.assertTrue(context.ok(), 'unload must not shut down the borrowed stack')
        finally:
            executor.shutdown(timeout_sec=2)
            robot.destroy_node()
            rclpy.try_shutdown(context=context)
            thread.join(2)


if __name__ == '__main__':
    unittest.main()

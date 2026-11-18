"""Native ROS regression tests; run with the configured ROS Python/overlays."""
import asyncio
import json
from pathlib import Path
import tempfile
import unittest

from rclpy.serialization import deserialize_message
from rosgraph_msgs.msg import Clock
from std_msgs.msg import Float64, String
from geometry_msgs.msg import TransformStamped
from tf2_ros import StaticTransformBroadcaster
import rosbag2_py

from kinex.communication import communication, qos
from kinex.host.recording import Recording
from kinex.communication import message_value
from kinex.common.plain import plain
from kinex.values import components, pose

CATALOG = {
    "environment.time": {"transport": "topic", "direction": "output", "endpoint": "/recording_test/clock",
                         "type": "rosgraph_msgs/msg/Clock", "qos": {"durability": "transient_local"}},
    "sensor.value": {"transport": "topic", "direction": "output", "endpoint": "/recording_test/value",
                     "type": "std_msgs/msg/Float64"},
    "sensor.label": {"transport": "topic", "direction": "output", "endpoint": "/recording_test/label",
                     "type": "std_msgs/msg/String"},
    "sensor.command": {"transport": "topic", "direction": "input", "endpoint": "/recording_test/command",
                       "type": "std_msgs/msg/Float64"},
}


async def until(predicate):
    async with asyncio.timeout(5):
        while not predicate():
            await asyncio.sleep(.01)


class RecordingTests(unittest.IsolatedAsyncioTestCase):
    async def test_topics_paused_world_rate_reset_tf_and_bag_roundtrip(self):
        with tempfile.TemporaryDirectory() as directory:
            async with communication(CATALOG, domain_id=181) as io:
                clock = io.node.create_publisher(Clock, CATALOG['environment.time']['endpoint'], qos(CATALOG['environment.time']))
                value = io.node.create_publisher(Float64, CATALOG['sensor.value']['endpoint'], 10)
                label = io.node.create_publisher(String, CATALOG['sensor.label']['endpoint'], 10)
                command = io.node.create_publisher(Float64, CATALOG['sensor.command']['endpoint'], 10)
                recorder = Recording(io, directory, ['sensor.value', 'sensor.label', 'sensor.command'], 10)
                recorder.start()
                try:
                    await until(lambda: value.get_subscription_count() and label.get_subscription_count() and command.get_subscription_count())
                    def tick(sec, nanosec=0):
                        message = Clock()
                        message.clock.sec, message.clock.nanosec = sec, nanosec
                        clock.publish(message)
                    tick(10)
                    await until(lambda: io.world_stamp == 10_000_000_000)
                    tf = TransformStamped()
                    tf.header.frame_id, tf.child_frame_id = 'world', 'sensor'
                    tf.transform.rotation.w = 1.
                    broadcaster = StaticTransformBroadcaster(io.node)
                    broadcaster.sendTransform(tf)
                    value.publish(Float64(data=1.25))
                    label.publish(String(data='ready'))
                    await until(lambda: recorder.samples == 2)
                    # Paused time does not duplicate captures, even with fresh transport.
                    value.publish(Float64(data=2.5))
                    await until(lambda: recorder.skipped == 1)
                    await asyncio.sleep(.05)
                    self.assertEqual(io.world_stamp, 10_000_000_000)
                    self.assertEqual(recorder.samples, 2)
                    tick(10, 200_000_000)
                    await until(lambda: io.world_stamp == 10_200_000_000)
                    value.publish(Float64(data=3.75))
                    await until(lambda: recorder.samples == 3)
                    tick(0)
                    await until(lambda: io.world_epoch == 1)
                    value.publish(Float64(data=5.))
                    await until(lambda: recorder.samples == 4)
                    # Commands are observed, never invoked or rate-filtered.
                    for target in (6., 7., 8.):
                        command.publish(Float64(data=target))
                    await until(lambda: recorder.counts['sensor.command'] == 3)
                    await until(lambda: recorder.counts['_frames.static'] > 0)
                finally:
                    facts = await recorder.stop()
                self.assertEqual(facts['status'], 'stopped')
                self.assertFalse(io.closed)
                self.assertFalse(io.subscriptions)
                self.assertEqual(await recorder.stop(), facts)
            rows = [json.loads(line) for line in (Path(directory) / 'samples.jsonl').read_text().splitlines()]
            samples = [row for row in rows if row['operation'] == 'sensor.value']
            self.assertEqual([row['world_ns'] for row in samples], [10_000_000_000, 10_200_000_000, 0])
            self.assertEqual([row['epoch'] for row in samples], [0, 0, 1])
            reader = rosbag2_py.SequentialReader()
            reader.open(rosbag2_py.StorageOptions(uri=str(Path(directory) / 'bag'), storage_id='sqlite3'),
                        rosbag2_py.ConverterOptions('cdr', 'cdr'))
            values = []
            while reader.has_next():
                topic, data, stamp = reader.read_next()
                if topic == '/recording_test/value':
                    values.append(deserialize_message(data, Float64).data)
            self.assertEqual(values, [1.25, 3.75, 5.])
            del reader  # Humble readers have no close().

    async def test_poses_and_seconds_convert_to_and_from_native_messages(self):
        import numpy as np
        from sensor_msgs.msg import JointState
        from trajectory_msgs.msg import JointTrajectory, MultiDOFJointTrajectory
        relation = TransformStamped()
        relation.transform.translation.x = 1.
        relation.transform.rotation.z = 2 ** -.5
        relation.transform.rotation.w = 2 ** -.5
        relation.header.stamp.sec, relation.header.stamp.nanosec = 2, 500000000
        child, parent = pose([1, 0, 0, 0, 0, 0, 1]), pose([0, 1, 0, 0, 0, 0, 1])
        # A lookup's message is a pose: products move poses between frames.
        np.testing.assert_allclose((pose(relation) * child).translation, [1, 1, 0], atol=1e-12)
        np.testing.assert_allclose((parent.inv() * pose(relation) * child).translation, [1, 0, 0], atol=1e-12)
        self.assertEqual(plain(relation)["header"]["stamp"], 2.5)
        # A program's values become fields by their declared types, and its payload stays its own.
        state = JointState(position=[.1, .2])
        points = [{"positions": state.position, "time_from_start": 1.5}, {"positions": np.array([.3, .4]), "time_from_start": 2}]
        message = message_value(JointTrajectory, {"joint_names": ["a", "b"], "points": points})
        self.assertEqual([list(point.positions) for point in message.points], [[.1, .2], [.3, .4]])
        self.assertEqual([(point.time_from_start.sec, point.time_from_start.nanosec) for point in message.points], [(1, 500000000), (2, 0)])
        self.assertIsInstance(points[0], dict)
        tips = message_value(MultiDOFJointTrajectory, {"joint_names": ["tcp"], "points": [{"transforms": pose(relation), "time_from_start": .5}]})
        np.testing.assert_allclose(components(tips.points[0].transforms[0]), components(relation))


if __name__ == '__main__':
    unittest.main()

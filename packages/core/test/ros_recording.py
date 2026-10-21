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
from kinex.ros_recording import Recording
from kinex.ros_tools import relative_pose, transform_pose

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
            for metadata in reader.get_all_topics_and_types():
                self.assertTrue(metadata.offered_qos_profiles)
            values = []
            while reader.has_next():
                topic, data, stamp = reader.read_next()
                if topic == '/recording_test/value':
                    values.append(deserialize_message(data, Float64).data)
            self.assertEqual(values, [1.25, 3.75, 5.])
            reader.close()

    async def test_tf2_offsets_and_pose_conversion(self):
        relation = TransformStamped()
        relation.transform.translation.x = 1.
        relation.transform.rotation.z = 2 ** -.5
        relation.transform.rotation.w = 2 ** -.5
        child = [1, 0, 0, 0, 0, 0, 1]
        parent = [0, 1, 0, 0, 0, 0, 1]
        result = relative_pose(relation, child, parent)
        for actual, expected in zip(result[:3], [1, 0, 0]):
            self.assertAlmostEqual(actual, expected)
        from unittest.mock import patch
        async def lookup(*args):
            return relation
        with patch('kinex.helpers.lookup_transform', lookup):
            result = await transform_pose(None, child, 'camera', 'world')
        for actual, expected in zip(result[:3], [1, 1, 0]):
            self.assertAlmostEqual(actual, expected)


if __name__ == '__main__':
    unittest.main()

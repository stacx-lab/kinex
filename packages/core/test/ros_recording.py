"""Native ROS regression tests; run with the configured ROS Python/overlays."""
import asyncio
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from rclpy.serialization import deserialize_message
from rosgraph_msgs.msg import Clock
from sensor_msgs.msg import Image
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
    **{f"camera.{name}": {"transport": "topic", "direction": "output", "endpoint": f"/recording_test/{name}",
                          "type": "sensor_msgs/msg/Image"} for name in ("image", "depth", "kept")},
}


def bag(directory):
    """Every message of a recorded bag, by topic, whichever storage wrote it."""
    reader, messages = rosbag2_py.SequentialReader(), {}
    reader.open(rosbag2_py.StorageOptions(uri=str(Path(directory) / 'bag')), rosbag2_py.ConverterOptions('cdr', 'cdr'))
    while reader.has_next():
        topic, data, _ = reader.read_next()
        messages.setdefault(topic, []).append(data)
    del reader  # Humble readers have no close().
    return messages


async def until(predicate):
    async with asyncio.timeout(5):
        while not predicate():
            await asyncio.sleep(.01)


class RecordingTests(unittest.IsolatedAsyncioTestCase):
    async def test_topics_paused_world_rate_reset_tf_and_bag_roundtrip(self):
        with tempfile.TemporaryDirectory() as directory:
            async with communication(CATALOG, domain_id=181) as io:
                clock = io.bridge.node.create_publisher(Clock, CATALOG['environment.time']['endpoint'], qos(CATALOG['environment.time']))
                value = io.bridge.node.create_publisher(Float64, CATALOG['sensor.value']['endpoint'], 10)
                label = io.bridge.node.create_publisher(String, CATALOG['sensor.label']['endpoint'], 10)
                command = io.bridge.node.create_publisher(Float64, CATALOG['sensor.command']['endpoint'], 10)
                recorder = Recording(io, directory, {name: {'rate': 10} for name in ('sensor.value', 'sensor.label', 'sensor.command')}, tf=True)
                recorder.start()
                try:
                    await until(lambda: value.get_subscription_count() and label.get_subscription_count() and command.get_subscription_count())
                    def tick(sec, nanosec=0):
                        message = Clock()
                        message.clock.sec, message.clock.nanosec = sec, nanosec
                        clock.publish(message)
                    tick(10)
                    await until(lambda: io.bridge.world_stamp == 10_000_000_000)
                    tf = TransformStamped()
                    tf.header.frame_id, tf.child_frame_id = 'world', 'sensor'
                    tf.transform.rotation.w = 1.
                    broadcaster = StaticTransformBroadcaster(io.bridge.node)
                    broadcaster.sendTransform(tf)
                    value.publish(Float64(data=1.25))
                    label.publish(String(data='ready'))
                    await until(lambda: recorder.samples == 2)
                    # Paused time does not duplicate captures, even with fresh transport.
                    value.publish(Float64(data=2.5))
                    await until(lambda: recorder.skipped == 1)
                    await asyncio.sleep(.05)
                    self.assertEqual(io.bridge.world_stamp, 10_000_000_000)
                    self.assertEqual(recorder.samples, 2)
                    tick(10, 200_000_000)
                    await until(lambda: io.bridge.world_stamp == 10_200_000_000)
                    value.publish(Float64(data=3.75))
                    await until(lambda: recorder.samples == 3)
                    tick(0)
                    # The scope drops what it observed before a reset; publish once it has seen this one.
                    await until(lambda: io.epoch == 1)
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
            self.assertEqual(facts['storage'], 'mcap')
            recorded = bag(directory)
            self.assertEqual([deserialize_message(data, Float64).data for data in recorded['/recording_test/value']], [1.25, 3.75, 5.])
            self.assertIn('/tf_static', recorded)

    async def test_a_device_capture_leaves_the_clock_and_tf_to_the_domains(self):
        with tempfile.TemporaryDirectory() as directory:
            async with communication(CATALOG, domain_id=181) as io:
                clock = io.bridge.node.create_publisher(Clock, CATALOG['environment.time']['endpoint'], qos(CATALOG['environment.time']))
                value = io.bridge.node.create_publisher(Float64, CATALOG['sensor.value']['endpoint'], 10)
                recorder = Recording(io, directory, {'sensor.value': {'rate': 10}})
                recorder.start()
                try:
                    await until(value.get_subscription_count)
                    clock.publish(Clock())
                    await until(lambda: io.bridge.world_stamp is not None)
                    StaticTransformBroadcaster(io.bridge.node).sendTransform(TransformStamped())
                    value.publish(Float64(data=1.))
                    await until(lambda: recorder.samples == 1)
                finally:
                    facts = await recorder.stop()
            self.assertEqual(list(facts['operations']), ['sensor.value'])
            self.assertEqual(list(bag(directory)), ['/recording_test/value'])

    async def test_color_goes_to_video_and_depth_stays_typed_each_at_its_own_rate(self):
        color = lambda shade, width=64: Image(height=48, width=width, encoding='rgb8', step=width * 3, data=bytes([shade]) * (48 * width * 3))
        depth = Image(height=48, width=64, encoding='16UC1', step=128, data=bytes(range(256)) * 24)
        with tempfile.TemporaryDirectory() as directory:
            async with communication(CATALOG, domain_id=181) as io:
                clock = io.bridge.node.create_publisher(Clock, CATALOG['environment.time']['endpoint'], qos(CATALOG['environment.time']))
                publishers = {name: io.bridge.node.create_publisher(Image, CATALOG[f'camera.{name}']['endpoint'], 10) for name in ('image', 'depth', 'kept')}
                recorder = Recording(io, directory, {'camera.image': {'rate': 10}, 'camera.depth': {'rate': 2},
                                                     'camera.kept': {'rate': 10, 'format': 'bag'}})
                recorder.start()
                try:
                    await until(lambda: all(publisher.get_subscription_count() for publisher in publishers.values()))
                    for step in range(6):  # 0.1 s of world time a step: every color frame is due, every fifth depth frame
                        message = Clock()
                        message.clock.sec, message.clock.nanosec = 10, step * 100_000_000
                        clock.publish(message)
                        await until(lambda: io.bridge.world_stamp == 10_000_000_000 + step * 100_000_000)
                        # The fourth frame is wider: it starts the operation's next video.
                        publishers['image'].publish(color(40 * step, 80 if step >= 3 else 64))
                        publishers['depth'].publish(depth)
                        publishers['kept'].publish(color(200))
                        await until(lambda: recorder.counts['camera.image'] == step + 1 and recorder.counts['camera.kept'] == step + 1)
                    await until(lambda: recorder.counts['camera.depth'] == 2)
                finally:
                    facts = await recorder.stop()
            self.assertIsNone(facts.get('error'))
            self.assertEqual(facts['operations'], {'camera.image': 6, 'camera.depth': 2, 'camera.kept': 6})
            self.assertEqual([Path(file).name for file in facts['videos']['camera.image']], ['image.mp4', 'image.1.mp4'])
            rows = [json.loads(line) for line in (Path(directory) / 'samples.jsonl').read_text().splitlines()]
            self.assertEqual([(row['file'], row['frame']) for row in rows if row['operation'] == 'camera.image'],
                             [('image.mp4', 0), ('image.mp4', 1), ('image.mp4', 2), ('image.1.mp4', 0), ('image.1.mp4', 1), ('image.1.mp4', 2)])
            self.assertEqual([row['world_ns'] for row in rows if row['operation'] == 'camera.depth'], [10_000_000_000, 10_500_000_000])
            self.assertTrue(all('file' not in row for row in rows if row['operation'] != 'camera.image'))
            # Depth and the color operation kept in the bag come back bit for bit; the video operation is not in the bag.
            recorded = bag(directory)
            self.assertEqual(sorted(recorded), ['/recording_test/depth', '/recording_test/kept'])
            self.assertEqual(bytes(deserialize_message(recorded['/recording_test/depth'][0], Image).data), bytes(depth.data))
            self.assertEqual(len(recorded['/recording_test/kept']), 6)
            probe = shutil.which('ffprobe')
            for file, width in (('image.mp4', 64), ('image.1.mp4', 80)):
                stream = json.loads(subprocess.run([probe, '-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries',
                    'stream=codec_name,width,height,nb_read_frames', '-of', 'json', str(Path(directory) / file)],
                    check=True, capture_output=True, text=True).stdout)['streams'][0]
                self.assertEqual((stream['codec_name'], stream['width'], stream['height'], stream['nb_read_frames']), ('h264', width, 48, '3'))

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

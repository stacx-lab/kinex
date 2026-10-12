"""Device-local ROS configuration: validation and read-only loading."""

from pathlib import Path
import tempfile
import unittest
import yaml

from kinex_ros.config import load
from kinex_ros.ros2 import ROSError
from kinex_ros.ros2_drivers import ros_driver
from ros2_fixtures import fixture


class ROSProfileTests(unittest.TestCase):
    def test_flat_config_drives_adapter_without_auxiliary_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            fixture(directory)
            before = {p.name: p.read_bytes() for p in directory.iterdir() if p.is_file()}
            config = load(directory)
            self.assertEqual(config['state_topic'], '/joint_states')
            self.assertEqual(config['domain_id'], 0)
            driver = ros_driver(directory)
            self.assertEqual(driver.directory, directory)
            self.assertEqual(driver.names, ['a', 'b'])
            self.assertIsNone(driver.handle)
            self.assertEqual(before, {p.name: p.read_bytes() for p in directory.iterdir() if p.is_file()})

    def test_invalid_ros_values_are_rejected_before_connecting(self):
        invalid = [[], None, {'domain_id': True}, {'domain_id': 233},
                   {'namespace': '/invalid space'}, {'expected': []}, {'stop': []},
                   {'state_topic': 4}, {'period_s': 0}, {'period_s': float('nan')},
                   {'color_image_space': 'unknown'}, {'timestamp_source': 'wall'}]
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            for value in invalid:
                with self.subTest(value=value):
                    (directory / 'profile_ros.yaml').write_text(yaml.safe_dump(value))
                    with self.assertRaises(ROSError):
                        load(directory)



if __name__ == '__main__':
    unittest.main()

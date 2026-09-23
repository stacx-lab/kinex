"""Exercise the shipped SDK wrappers with deterministic vendor hooks."""
import importlib.util
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from kinex.joint_driver import Driver as JointDriver
from kinex.joints import JointDevice
from kinex.velocity_driver import Driver as VelocityDriver
from kinex.control import stop_all, stop_on_error
import kinex.control as control

ROOT = Path(__file__).resolve().parents[1]
JOINT = {
    'name': 'arm', 'type': 'joint', 'intrinsics': {
        'model': {'format': 'joints', 'joints': [{'name': 'j0', 'type': 'revolute',
                  'limits': {'min': -2, 'max': 2}, 'max_velocity': 2, 'max_effort': None}]},
        'home': None, 'control': {'mode': 'position'}, 'frames': {},
        'feedback': {'velocities': True, 'efforts': False, 'clock': 'simulation'},
    },
}
VELOCITY = {
    'name': 'base', 'type': 'velocity', 'intrinsics': {
        'control': {'mode': 'motion', 'modes': {'walk': {'velocity': {'components': [
            {'axis': 'vx', 'units': 'm/s', 'bounds': {'min': -1, 'max': 1}}]}, 'posture': None}}},
        'frames': {}, 'feedback': {'pose_frame': None, 'velocity_frame': 'base',
                                 'velocity_components': ['vx'], 'clock': 'simulation'},
    },
}
SCALAR = {'intrinsics': {'control': {'mode': 'direction'}, 'feedback': {
    'positions': ['finger'], 'velocities': True, 'clock': 'simulation', 'sensors': {},
}}}


def snapshot(kind):
    if kind == 'velocity':
        return {'pose': None, 'velocities': [0.2], 'faults': [], 'sample_time_s': .1, 'frame_poses': {}}
    return {'positions': [.2], 'velocities': [0.0], 'efforts': [], 'faults': [], 'sample_time_s': .1}


def outcome(kind):
    return {'accepted': True, 'elapsed_s': .1, 'reached': True, 'state': snapshot(kind)}


class DriverContracts(unittest.TestCase):
    def adapters(self):
        joint = JointDriver.__new__(JointDriver)
        joint.profile = JOINT
        model = JointDevice(JOINT)
        joint.model = lambda: model
        joint.connection = lambda: object()
        joint.servo = lambda *_: outcome('joint')
        joint.halt = lambda *_: None
        velocity = VelocityDriver.__new__(VelocityDriver)
        velocity.profile, velocity.lock = VELOCITY, threading.RLock()
        velocity.error, velocity.serving = None, True
        velocity.connection = lambda: object()
        velocity.send_target = lambda *_: outcome('velocity')
        yield joint, {'actions': [[.2]], 'freq_hz': 10}
        yield velocity, {'mode': 'walk', 'velocity': {'vx': .2}, 'for_s': .1}
        for kind in ('gripper', 'suction'):
            spec = importlib.util.spec_from_file_location(kind, ROOT / 'assets/builtin/device/templates' / kind / 'driver.py')
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            module.PROFILE, module.HANDLE = SCALAR, object()
            module.send_target = lambda *_: outcome('scalar')
            yield module, {'target': [.2], 'for_s': .1}

    def test_wrappers_preserve_and_validate_execution_results(self):
        for adapter, args in self.adapters():
            with self.subTest(adapter=adapter):
                result = adapter.execute('write', args)
                self.assertEqual(result['elapsed_s'], .1)
                self.assertTrue(result.get('reached', result.get('completed_actions') == 1))
                self.assertEqual(result['state']['sample_time_s'], .1)
                self.assertEqual(result['state']['faults'], [])

    def test_bounded_velocity_write_does_not_depend_on_transport_mode(self):
        for adapter, args in self.adapters():
            if isinstance(adapter, VelocityDriver):
                adapter.serving = False
                self.assertEqual(adapter.execute('write', args)['elapsed_s'], .1)

    def test_budgets_are_required_before_any_sdk_effect(self):
        for adapter, args in self.adapters():
            for bad in (None, 0, -1, float('nan'), True):
                calls = []
                adapter.send_target = lambda *a: calls.append(a)
                field = 'freq_hz' if isinstance(adapter, JointDriver) else 'for_s'
                command = {**args, field: bad}
                if bad is None:
                    command.pop(field)
                with self.assertRaises(ValueError):
                    adapter.execute('write', command)
                self.assertEqual(calls, [])

    def test_malformed_sdk_results_are_not_fabricated(self):
        for adapter, args in self.adapters():
            for bad in (None, {'accepted': True}, {**outcome('joint'), 'elapsed_s': -1},
                        {**outcome('joint'), 'reached': 'yes'}, {**outcome('joint'), 'state': {}}):
                if isinstance(adapter, JointDriver):
                    if isinstance(bad, dict) and bad.get('reached') == 'yes':
                        continue  # write has no arrival field
                    adapter.servo = lambda *_, bad=bad: bad
                else:
                    adapter.send_target = lambda *_, bad=bad: bad
                with self.assertRaises((ValueError, KeyError)):
                    adapter.execute('write', args)

    def test_joint_sequence_prevalidates_every_point_and_stops_on_short_servo(self):
        driver, _ = next(self.adapters())
        effects = []
        driver.servo = lambda *args: effects.append(args) or outcome('joint')
        driver.halt = lambda _: effects.append('stop')
        with self.assertRaises(ValueError):
            driver.execute('write', {'actions': [[.2], [3]], 'freq_hz': 10})
        self.assertEqual(effects, [])
        driver.servo = lambda *_: {**outcome('joint'), 'elapsed_s': 0}
        with self.assertRaisesRegex(ValueError, 'period'):
            driver.execute('write', {'actions': [[.2]], 'freq_hz': 10})
        self.assertEqual(effects, ['stop'])

    def test_end_effector_buffers_validate_the_tail_and_honor_budget(self):
        for adapter, _ in self.adapters():
            if isinstance(adapter, (JointDriver, VelocityDriver)):
                continue
            calls, stops = [], []
            adapter.send_target = lambda handle, value, profile: calls.append(value) or {
                **outcome('scalar'), 'elapsed_s': value['for_s']}
            adapter.halt = lambda *_: stops.append(True)
            with self.assertRaises(ValueError):
                adapter.execute('write', {'actions': [[.2], [2]], 'freq_hz': 10})
            self.assertEqual(calls, [])
            result = adapter.execute('write', {
                'actions': [[.2], [-.2], [0]], 'freq_hz': 10, 'for_s': .25})
            self.assertEqual(result['completed_actions'], 2)
            self.assertEqual(result['terminated_by'], 'timeout')
            self.assertAlmostEqual(result['elapsed_s'], .25)
            self.assertEqual([value['target'] for value in calls], [[1], [-1], [0]])
            self.assertEqual(stops, [True])


    def test_stops_attempt_every_device_and_preserve_original_error(self):
        calls, previous = [], control.device
        def fail(name, action):
            calls.append(name)
            raise RuntimeError(name + ' unavailable')
        control.device = fail
        try:
            with self.assertRaisesRegex(RuntimeError, 'arm.*hand'):
                stop_all(['arm', 'hand'])
            self.assertEqual(calls, ['arm', 'hand'])
            original = ValueError('original action failed')
            try:
                with stop_on_error(['arm', 'hand']):
                    raise original
            except ValueError as error:
                self.assertIs(error, original)
                self.assertIn('stop failed', error.__notes__[0])
        finally:
            control.device = previous

    def test_failed_final_stop_is_reported_without_retrying(self):
        spec = importlib.util.spec_from_file_location('drive', ROOT / 'assets/builtin/tool/drive/tool.py')
        drive = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(drive)
        with patch.object(drive, 'device', return_value={'data': outcome('velocity')}), \
                patch.object(control, 'device', side_effect=RuntimeError('unavailable')) as device:
            with self.assertRaisesRegex(RuntimeError, 'stop failed: arm: unavailable'):
                drive.hold('arm', {'for_s': .1}, .1, None)
            device.assert_called_once_with('arm', 'stop')


if __name__ == '__main__':
    unittest.main()

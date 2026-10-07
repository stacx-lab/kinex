import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Device, isActuated } from '../dist/device/profile/schema.js'
import { writeCommand } from '../dist/device/command.js'
import { validateReading, validateWriteResult } from '../dist/device/dispatch.js'
import { isCommandAction, requiredActions } from '../dist/device/interface.js'

const profile = () => Device.parse({ name: 'base', type: 'legged_base',
  meta: { created_at: '', updated_at: '' }, intrinsics: {
    control: {
      device_modes: {
        crouched_down: { description: 'Resting', transitions: ['stand_still'] },
        stand_still: { description: 'Balanced', transitions: ['crouched_down', 'drive'] },
        drive: { description: 'Driving', transitions: ['stand_still'] },
      },
      skills: { walk: 'Walk a requested distance' },
      write: { type: 'object', properties: {
        mode: { type: 'string' }, skill: { type: 'string', enum: ['walk'] },
        distance: { type: 'number', minimum: 0, maximum: 1 },
        velocity: { type: 'object', properties: { vx: { type: 'number', minimum: -1, maximum: 1 } }, required: ['vx'] },
        duration_s: { type: 'number', minimum: .001 },
      }, required: [] },
    },
    stop: { behavior: 'Cancel the SDK operation and retain balance', affected_devices: ['base'] },
  },
})
const sample = mode => ({ mode, faults: [], timestamp: 1, sdk_progress: 0 })

test('legged writes use the declared SDK schema and retain actuation classification', () => {
  const device = profile()
  assert.ok(isActuated(device))
  assert.equal(isCommandAction(device, 'write'), true)
  assert.equal(isCommandAction(device, 'read'), false)
  assert.ok(requiredActions(device).includes('stop'))
  for (const command of [{ mode: 'stand_still' }, { skill: 'walk', distance: .2 },
    { mode: 'drive', velocity: { vx: .1 }, duration_s: .5 }])
    assert.deepEqual(writeCommand(device, command), command)
  for (const command of [{ mode: 'stunt' }, { skill: 'dance' }, { skill: 'walk', distance: 2 },
    { mode: 'drive', velocity: { vx: 2 }, duration_s: 1 }, { device_state: 'stand_still' }])
    assert.throws(() => writeCommand(device, command))
  const invalid = profile()
  invalid.intrinsics.control.device_modes.crouched_down.transitions = ['missing']
  assert.equal(Device.safeParse(invalid).success, false)
  const obsolete = profile()
  obsolete.intrinsics.control.device_state = { states: obsolete.intrinsics.control.device_modes }
  delete obsolete.intrinsics.control.device_modes
  assert.equal(Device.safeParse(obsolete).success, false)
  invalid.intrinsics.control.device_modes = {}
  assert.equal(Device.safeParse(invalid).success, false)
  delete device.intrinsics.control.device_modes
  assert.throws(() => writeCommand(device, { mode: 'stand_still' }), /unsupported device mode/)
})

test('legged feedback preserves SDK observations and validates measured write states', () => {
  const device = profile()
  for (const state of ['stand_still', 'sdk-transitioning', null]) {
    const data = sample(state)
    assert.deepEqual(validateReading(device, { data }).data, data)
    assert.deepEqual(validateWriteResult(device, { data: { execution_id: 'one', state: data } }).data.state, data)
  }
  for (const extra of [{ mode: undefined }, { mode: '' }, { mode: 1 },
    { timestamp: undefined }, { timestamp: Infinity }, { faults: ['fault'] }])
    assert.throws(() => validateReading(device, { data: { ...sample('stand_still'), ...extra } }))
  assert.throws(() => validateWriteResult(device, { data: { execution_id: 'one', state: { ...sample('stand_still'), faults: [{ code: 'fault' }] } } }))
  delete device.intrinsics.control.device_modes
  assert.doesNotThrow(() => validateReading(device, { data: { timestamp: 1, faults: [] } }))
})

test('legged scaffold keeps SDK hooks independent of velocity and lifecycle motion', () => {
  const file = fileURLToPath(new URL('../assets/builtin/device/templates/legged_base/driver.py', import.meta.url))
  execFileSync(process.env.PYTHON ?? 'python3', ['-c', `
import importlib.util
import sys
spec = importlib.util.spec_from_file_location('legged_template', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.settings = lambda directory: {}
class Fake(module.LeggedDriver):
    current = 'crouched_down'
    requests = 0
    stops = 0
    disconnected = False
    def connect(self): return object()
    def disconnect(self, handle): self.disconnected = True
    def read(self, args):
        return dict(mode=self.current, timestamp=1, faults=[], selector=args.get('selector'))
    def write(self, args):
        if set(args) != {'mode'} or args['mode'] not in ('crouched_down', 'stand_still'):
            raise ValueError('unsupported state command')
        if self.current != args['mode']:
            self.current = args['mode']
            self.requests += 1
        return dict(execution_id='sdk-operation', state=self.read({}))
    def stop(self):
        self.stops += 1
        return dict(stopped=True)
driver = Fake(None)
assert driver.execute('status', {}) == dict(connected=False)
assert not driver.dispatch('write', dict(mode='stand_still'))['ok']
driver.execute('load', {})
assert driver.current == 'crouched_down'
assert driver.execute('read', dict(selector='state'))['selector'] == 'state'
assert driver.execute('write', dict(mode='stand_still'))['state']['mode'] == 'stand_still'
driver.execute('write', dict(mode='stand_still'))
assert driver.requests == 1
assert not driver.dispatch('write', dict(mode='stunt'))['ok']
driver.execute('stop', {})
driver.execute('unload', {})
assert driver.disconnected and driver.stops == 2
driver.close()
assert driver.stops == 2
class BrokenStop(Fake):
    def stop(self): raise RuntimeError('stop failed')
broken = BrokenStop(None)
broken.execute('load', {})
assert broken.dispatch('stop', {})['code'] == 'stop_failed'
assert not broken.dispatch('write', dict(mode='stand_still'))['ok']
assert not broken.dispatch('unload', {})['ok']
assert broken.disconnected
`, file], { env: { ...process.env,
    PYTHONPATH: fileURLToPath(new URL('../assets/python', import.meta.url)), PYTHONDONTWRITEBYTECODE: '1',
  } })
})

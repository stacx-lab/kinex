// Controller tools execute buffered references against device-owned clocks.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

const root = fileURLToPath(new URL('../', import.meta.url))
const pythonLib = path.join(root, 'assets', 'python')
const toolDir = path.join(root, 'assets', 'builtin', 'tool')
const python = process.env.PYTHON ?? 'python3'
const tool = (name) => path.join(toolDir, name, 'tool.py')

function arm({ dof = 2, rate = 1, ik = null, type = 'joint' }) {
  const self = {
    positions: Array(dof).fill(0), target: Array(dof).fill(0), clock: 0,
    writes: 0, reads: 0, stops: 0, history: [], ik,
  }
  const advance = (seconds) => {
    self.clock += seconds
    self.positions = self.positions.map((p, i) => {
      const step = rate * seconds, goal = self.target[i]
      return Math.abs(goal - p) <= step ? goal : p + Math.sign(goal - p) * step
    })
  }
  const snapshot = () => ({
    positions: [...self.positions], velocities: self.positions.map(() => 0),
    efforts: [], faults: [], timestamp: self.clock,
  })
  self.read = () => { self.reads++; return snapshot() }
  self.write = (args) => {
    self.writes++
    self.history.push(...args.actions.map(q => [...q]))
    self.pending = args
    return { execution_id: 'test', state: snapshot() }
  }

  self.advance = seconds => { if (self.pending) self.target = self.pending.actions.at(-1); advance(seconds) }
  self.stop = () => { self.pending = null; self.stops++; self.target = [...self.positions]; return { stopped: true } }
  self.profile = () => ({
    name: 'arm', type, loaded: true,
    resolved_model: { joints: self.positions.map((_, i) => ({ name: `j${i}`, type: 'revolute', limits: { min: -3.2, max: 3.2 }, max_velocity: 2 })), chain: null },
    intrinsics: {
      control: { mode: 'position' },
      feedback: { velocities: true },
      kinematics: { ik: 'numerical', frame: 'flange' }, frames: {},
    },
  })
  return self
}

test('servo recovers home starts within a fixed one-degree angular margin', async () => {
  for (const sign of [-1, 1]) for (const [overshoot, goal, accepted] of [
    [1, 0, true], [1.01, 0, false], [.4, .1, false], [.5, 0, true],
  ]) {
    const self = arm({ dof: 1 }), original = self.profile
    self.positions = [sign * (3.2 + overshoot * Math.PI / 180)]
    self.profile = () => {
      const p = original()
      p.intrinsics.home = { j0: 0 }
      return p
    }
    const { result, stderr } = await dialog(tool('servo'), { device: 'arm', block: false, joints: [goal] }, { arm: self })
    assert.equal(Boolean(result), accepted, stderr)
    assert.equal(self.writes, accepted ? 1 : 0)
    if (accepted) {
      assert.deepEqual(self.history.at(-1), [0])
      assert.ok(Math.abs(self.history[0][0]) > 3.2)
      assert.ok(self.history.every((q, i) => i === 0 || Math.abs(q[0]) <= Math.abs(self.history[i - 1][0])))
    }
  }
})

// A model device handing back a scripted chunk.
function policy(chunks) {
  const self = { calls: 0, seen: [] }
  self.infer = (a) => { self.seen.push(a); return { ...chunks[Math.min(self.calls++, chunks.length - 1)] } }
  self.profile = () => ({ name: 'policy', type: 'model', loaded: true,
    intrinsics: { family: 'test', variant: null, operations: [{ name: 'infer' }], frames: {} } })
  return self
}

// The tool<->harness dialog: one JSON request per stdout line, one reply per stdin line.
function dialog(file, callArgs, devices, tools = {}, owned = new Set()) {
  return new Promise((resolve) => {
    const proc = spawn(python, [file], {
      env: { ...process.env, KINEX_TOOL_DIALOG: '1', PYTHONPATH: pythonLib },
    })
    proc.stdin.write(JSON.stringify({ args: callArgs }) + '\n')
    let stderr = '', done = false
    proc.stderr.on('data', (chunk) => { stderr += chunk })
    const act = (device, action, args) => {
      if (action === 'wait') return { ok: true, data: device.wait(args) }
      if (action === 'read') return { ok: true, data: device.read() }
      if (action === 'write') {
        owned.add(device)
        try { return { ok: true, data: device.write(args) } }
        catch (error) { return { ok: false, error: error.message, code: error.code, details: error.details } }
      }
      if (action === 'stop') return { ok: true, data: device.stop() }
      if (action === 'ik') {
        device.ikArgs = args
        try { return { ok: true, data: { joints: typeof device.ik === 'function' ? device.ik(args) : device.ik } } }
        catch (error) { return { ok: false, error: error.message, code: error.code, details: error.details } }
      }
      if (action === 'fk') return { ok: true, data: device.fk?.(args) ?? { pose: [0, 0, 0, 0, 0, 0, 1] } }
      if (action === 'infer') return { ok: true, data: device.infer(args) }
      return { ok: false, error: `no action ${action}` }
    }
    const reply = (value) => proc.stdin.write(JSON.stringify(value) + '\n')
    createInterface({ input: proc.stdout }).on('line', (line) => {
      let message
      try { message = JSON.parse(line) } catch { return }
      if ('return' in message) { done = true; resolve({ result: message.return, stderr }); proc.stdin.end(); return }
      if ('error' in message) { done = true; resolve({ ...message, stderr }); proc.stdin.end(); return }
      const { call } = message
      if (call === 'stop_owned') {
        for (const device of owned) device.stop()
        return reply({ ok: true })
      }
      if (call === 'profile') return reply({ ok: true, profile: devices[message.device]?.profile() ?? null })
      if (call === 'device') {
        const result = act(devices[message.deviceID], message.action ?? 'read', message.args ?? {})
        return reply(result.ok ? { ok: true, result: { ...result.data, ...(result.file ? { file: result.file } : {}) } } : result)
      }
      if (call === 'devices') return reply({ ok: true, result: { results: message.calls.map(c => ({
        deviceID: c.deviceID, action: c.action ?? 'read', ...act(devices[c.deviceID], c.action ?? 'read', c.args ?? {}) })) } })
      if (call === 'tool') {
        // Compose real builtin tools recursively, as python-runner.ts does, so a
        // composition test exercises the actual tools rather than stand-ins.
        const stub = tools[message.name]
        if (stub) {
          try { return reply({ ok: true, result: stub(message.args ?? {}) }) }
          catch (error) { return reply({ ok: false, error: error.message }) }
        }
        return void dialog(path.join(toolDir, message.name.replace(/_/g, '-'), 'tool.py'),
                           message.args ?? {}, devices, tools, owned)
          .then(({ result, error: failed, stderr: nested }) => reply(
            result ? { ok: true, result } : { ok: false, error: failed ?? nested.slice(-400) }))
      }
      return reply({ ok: false, error: `unknown call ${call}` })
    })
    proc.on('close', () => { if (!done) resolve({ error: null, stderr }) })
  })
}

test('relative_pose composes both local rotations and offsets and reverses the result', async () => {
  const device = arm({}), prof = device.profile, q = Math.SQRT1_2
  device.profile = () => { const p = prof(); p.intrinsics.frames.camera = { parent_frame: null, translation_m: [1, 2, 3], rotation_xyzw: [0, 0, q, q] }; return p }
  const child = { frame: 'arm:camera', pose: [1, 0, 0, 1, 0, 0, 0] }
  const parent = { frame: 'arm', pose: [1, 1, 1, 0, 0, q, q] }
  const near = (actual, expected) => actual.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < 1e-9, `${actual} != ${expected}`))
  for (const [a, b, expected] of [[child, parent, [2, 0, 2, 1, 0, 0, 0]], [parent, child, [-2, 0, 2, 1, 0, 0, 0]]]) {
    const { result, stderr } = await dialog(tool('relative-pose'), { child: a, parent: b }, { arm: device })
    assert.ok(result, stderr)
    near(result.pose, expected)
    assert.equal(result.pose.length, 7)
    assert.deepEqual(result, { pose: result.pose,
      path: [{ from: a.frame, to: b.frame, kind: 'static', inverse: a === parent }], estimated_links: 0 })
  }
  const identity = await dialog(tool('relative-pose'), { child: { frame: 'arm' }, parent: { frame: 'arm' } }, { arm: device })
  assert.deepEqual(identity.result, { pose: [0, 0, 0, 0, 0, 0, 1], path: [], estimated_links: 0 })
  const bad = await dialog(tool('relative-pose'), { child: { ...child, pose: [0, 0, 0, 0, 0, 0, 0] }, parent }, { arm: device })
  assert.match(bad.stderr, /unit quaternion/)
  assert.equal(device.writes, 0)
  assert.equal(device.reads, 0)
})

test('policy validates every point before submitting its chunk', async () => {
  const device = arm({})
  const { result, stderr } = await dialog(tool('run-policy'), {
    model: 'policy', command: [{ device: 'arm' }], observation: {},
  }, { arm: device, policy: policy([{ actions: [[0.1, 0.1], [99, 0]] }]) })
  assert.equal(result, undefined)
  assert.match(stderr, /limits/)
  assert.equal(device.writes, 0)
})
function cartesianArm() {
  const self = arm({})
  const originalProfile = self.profile
  self.profile = () => ({ ...originalProfile(),
    intrinsics: { ...originalProfile().intrinsics, kinematics: { fk: 'driver', ik: 'driver', frame: 'flange' }, frames: {} },
    extrinsics: { mount: { parent: 'world', parent_frame: 'world', translation_m: [1, 0, 0], rotation_xyzw: [0, 0, 0, 1] } },
  })
  self.fk = () => ({ pose: [0, 0, 0, 0, 0, 0, 1], frame: 'flange', reference_frame: null })
  self.solves = []
  self.ik = args => { self.solves.push(args); return args.pose.slice(0, 2) }
  return self
}
const rigidTool = { profile: () => ({ name: 'tip', type: 'other', intrinsics: { frames: {} },
  extrinsics: { mount: { parent: 'arm', parent_frame: 'flange', translation_m: [0.1, 0, 0], rotation_xyzw: [0, 0, 0, 1] } },
}) }

test('policy accumulates Cartesian deltas, removes tool offset and seeds buffered IK', async () => {
  const self = cartesianArm(), model = policy([{ actions: [[0.02, 0, 0, 0, 0, 0], [0.03, 0.01, 0, 0, 0, 0]] }])
  const { result, stderr } = await dialog(tool('run-policy'), {
    model: 'policy', observation: {}, inference_args: { seed: 7 }, task: 'move',
    command: [{ device: 'arm', space: 'pose_delta', frame: 'world', target_frame: 'tip' }],
  }, { arm: self, policy: model, tip: rigidTool })
  assert.ok(result, stderr)
  assert.equal(self.writes, 1)
  assert.deepEqual(self.solves[0].seed, [0, 0])
  assert.deepEqual(self.solves[1].seed, self.solves[0].pose.slice(0, 2))
  assert.ok(Math.abs(self.history[0][0] - 0.02) < 1e-10)
  assert.ok(Math.abs(self.history[1][0] - 0.05) < 1e-10)
  assert.equal(self.history[1][1], 0.01)
  assert.deepEqual(model.seen, [{ obs: {}, task: 'move', seed: 7 }])
})

test('policy caps the execution horizon before splitting actions or solving IK', async () => {
  const self = cartesianArm(), submitted = []
  const gripper = {
    profile: () => ({ type: 'gripper', intrinsics: { control: {
      mode: 'position', bounds: { min: 0, max: 1 }, resolution: null, speed: null,
    } } }),
    write: args => { submitted.push(args); return { execution_id: 'gripper', state: { faults: [] } } },
    stop: () => ({}),
  }
  const { result, stderr } = await dialog(tool('run-policy'), {
    model: 'policy', observation: {}, max_actions: 2, action_hz: 20,
    command: [{ device: 'arm', space: 'pose_delta' }, { device: 'gripper' }],
  }, { arm: self, gripper, policy: policy([{ actions: [
    [.1, 0, 0, 0, 0, 0, .2], [.1, 0, 0, 0, 0, 0, .4],
    [99, 0, 0, 0, 0, 0, 99], [],
  ] }]) })
  assert.ok(result, stderr)
  assert.deepEqual(result, { actions_submitted: 2, duration_s: .1,
    execution_ids: { arm: 'test', gripper: 'gripper' }, ik_failure: null })
  assert.equal(self.solves.length, 2)
  assert.deepEqual(self.pending, { actions: [[.1, 0], [.2, 0]], duration_s: .1 })
  assert.deepEqual(submitted, [{ actions: [.2, .4], duration_s: .1 }])
})

test('Cartesian policy projects its initial IK seed while preserving measured FK inputs', async () => {
  const device = cartesianArm(), measurements = []
  device.positions = [3.201, -3.201]
  const fk = device.fk
  device.fk = args => { measurements.push(args.joints); return fk(args) }
  const solve = device.ik
  device.ik = args => {
    assert.ok(args.seed.every(value => value >= -3.2 && value <= 3.2))
    return solve(args)
  }
  const { result, stderr } = await dialog(tool('run-policy'), {
    model: 'policy', observation: {}, command: [{ device: 'arm', space: 'pose_delta' }],
  }, { arm: device, policy: policy([{ actions: [[.1, 0, 0, 0, 0, 0], [.1, 0, 0, 0, 0, 0]] }]) })
  assert.ok(result, stderr)
  assert.deepEqual(device.solves.map(args => args.seed), [[3.2, -3.2], [.1, 0]])
  assert.deepEqual(measurements, [[3.201, -3.201]])
  assert.deepEqual(device.positions, [3.201, -3.201])
  assert.equal(result.actions_submitted, 2)
})

test('policy propagates structured stop failures in IK and cleans up partial write failures', async () => {
  const details = { effects: 'unknown', validation_error: 'bad feedback', cleanup_error: 'halt rejected' }
  for (const stage of ['ik', 'write']) {
    const device = cartesianArm(), peer = arm({})
    device[stage] = () => { throw Object.assign(new Error('cleanup failed'), { code: 'stop_failed', details }) }
    const outcome = await dialog(tool('run-policy'), {
      model: 'policy', observation: {},
      command: [{ device: 'peer' }, { device: 'arm', space: 'pose_delta' }],
    }, { peer, arm: device, policy: policy([{ actions: [[.1, .2, .1, 0, 0, 0, 0, 0]] }]) })
    assert.equal(outcome.result, undefined)
    assert.equal(outcome.error, 'cleanup failed')
    assert.equal(outcome.code, 'stop_failed')
    assert.deepEqual(outcome.details, details)
    assert.equal(peer.writes, stage === 'write' ? 1 : 0)
    assert.equal(peer.stops, stage === 'write' ? 1 : 0)
    assert.equal(device.stops, stage === 'write' ? 1 : 0)
    if (stage === 'write') assert.equal(peer.pending, null)
  }
})

test('policy execution horizon accepts shorter chunks and single-action inference', async () => {
  for (const chunk of [{ actions: [[.1, .2], [.2, .3]] }, { action: [.1, .2] }]) {
    const self = arm({}), actions = chunk.actions ?? [chunk.action]
    const { result, stderr } = await dialog(tool('run-policy'), {
      model: 'policy', observation: {}, max_actions: 10, action_hz: 20,
      command: [{ device: 'arm' }],
    }, { arm: self, policy: policy([chunk]) })
    assert.ok(result, stderr)
    assert.equal(result.actions_submitted, actions.length)
    assert.equal(result.duration_s, actions.length / 20)
    assert.deepEqual(self.pending, { actions, duration_s: actions.length / 20 })
  }
})

test('policy rotates about the tool origin and converts absolute Cartesian goals', async () => {
  for (const space of ['pose_delta', 'pose']) {
    const self = cartesianArm()
    const action = space === 'pose_delta' ? [0, 0, 0, 0, 0, Math.PI / 2] : [1.1, 0, 0, 0, 0, Math.SQRT1_2, Math.SQRT1_2]
    const { result, stderr } = await dialog(tool('run-policy'), {
      model: 'policy', observation: {}, command: [{ device: 'arm', space, frame: 'world', target_frame: 'tip' }],
    }, { arm: self, policy: policy([{ actions: [action] }]), tip: rigidTool })
    assert.ok(result, stderr)
    assert.ok(Math.abs(self.ikArgs.pose[0] - 0.1) < 1e-10)
    assert.ok(Math.abs(self.ikArgs.pose[1] + 0.1) < 1e-10)
    assert.ok(Math.abs(self.ikArgs.pose[5] - Math.SQRT1_2) < 1e-10)
  }
})

test('policy submits the valid prefix on rejected, malformed or out-of-limits IK results', async () => {
  for (const failure of ['rejected', 'malformed', 'limits']) {
    for (const space of ['pose', 'pose_delta']) {
      const self = cartesianArm()
      self.ik = args => {
        self.solves.push(args)
        if (self.solves.length === 2) {
          if (failure === 'rejected') throw new Error('No IK solution found')
          return failure === 'malformed' ? null : [99, 0]
        }
        return [0.1, 0]
      }
      const action = space === 'pose' ? [0.1, 0, 0, 0, 0, 0, 1] : [0.1, 0, 0, 0, 0, 0]
      const { result, stderr } = await dialog(tool('run-policy'), {
        model: 'policy', observation: {}, command: [{ device: 'arm', space }], action_hz: 20,
      }, { arm: self, policy: policy([{ actions: Array(3).fill(action) }]) })
      assert.ok(result, stderr)
      assert.equal(result.actions_submitted, 1)
      assert.equal(result.duration_s, .05)
      assert.equal(result.ik_failure.device, 'arm')
      assert.equal(result.ik_failure.action_index, 1)
      assert.match(result.ik_failure.error, /No IK solution|joint target|joint limits/)
      assert.deepEqual(self.pending, { actions: [[.1, 0]], duration_s: .05 })
      assert.equal(self.solves.length, 2)
      assert.equal(self.writes, 1)
      assert.equal(self.stops, 0)
    }
  }
})

test('policy trims all devices to the earliest IK failure and preserves action cadence', async () => {
  const left = cartesianArm(), right = cartesianArm(), submitted = []
  const rightProfile = right.profile
  right.profile = () => ({ ...rightProfile(), name: 'right' })
  for (const [device, failureIndex] of [[left, 3], [right, 1]]) {
    device.ik = args => {
      device.solves.push(args)
      if (device.solves.length === failureIndex + 1) throw new Error('unreachable')
      return [.1 * device.solves.length, 0]
    }
  }
  const gripper = {
    profile: () => ({ type: 'gripper', intrinsics: { control: {
      mode: 'position', bounds: { min: 0, max: 1 }, resolution: null, speed: null,
    } } }),
    write: args => { submitted.push(args); return { execution_id: 'gripper', state: { faults: [] } } },
    stop: () => ({}),
  }
  const { result, stderr } = await dialog(tool('run-policy'), {
    model: 'policy', observation: {}, action_hz: 20,
    command: [{ device: 'gripper' }, { device: 'arm', space: 'pose_delta' }, { device: 'right', space: 'pose_delta' }],
  }, { arm: left, right, gripper, policy: policy([{ actions: [.2, .4, .6, .8, 1].map(g => [g, .1, 0, 0, 0, 0, 0, .1, 0, 0, 0, 0, 0]) }]) })
  assert.ok(result, stderr)
  assert.equal(result.actions_submitted, 1)
  assert.equal(result.duration_s, .05)
  assert.deepEqual(result.ik_failure, { device: 'right', action_index: 1, error: 'unreachable' })
  assert.deepEqual(submitted, [{ actions: [.2], duration_s: .05 }])
  for (const device of [left, right]) {
    assert.deepEqual(device.pending, { actions: [[.1, 0]], duration_s: .05 })
    assert.equal(device.writes, 1)
  }
  assert.equal(left.solves.length, 4)
  assert.equal(right.solves.length, 2)
})

test('policy returns normally and preserves existing buffers when the first IK action fails', async () => {
  const self = cartesianArm(), peer = arm({})
  const pending = { actions: [[.2, .1]], duration_s: 1 }
  self.pending = pending
  self.ik = () => { throw new Error('unreachable') }
  const { result, stderr } = await dialog(tool('run-policy'), {
    model: 'policy', observation: {}, command: [{ device: 'peer' }, { device: 'arm', space: 'pose_delta' }],
  }, { peer, arm: self, policy: policy([{ actions: Array(2).fill([.1, .2, .1, 0, 0, 0, 0, 0]) }]) })
  assert.deepEqual(result, { actions_submitted: 0, duration_s: 0, execution_ids: {},
    ik_failure: { device: 'arm', action_index: 0, error: 'unreachable' } }, stderr)
  assert.equal(self.writes, 0)
  assert.equal(peer.writes, 0)
  assert.equal(self.stops, 0)
  assert.equal(peer.stops, 0)
  assert.equal(self.pending, pending)
})

test('policy rotation deltas use reference axes rather than rotating tool axes', async () => {
  const self = cartesianArm()
  self.fk = () => ({ pose: [0, 0, 0, Math.SQRT1_2, 0, 0, Math.SQRT1_2], frame: 'flange', reference_frame: null })
  const { result, stderr } = await dialog(tool('run-policy'), {
    model: 'policy', observation: {}, command: [{ device: 'arm', space: 'pose_delta' }],
  }, { arm: self, policy: policy([{ actions: [[0, 0, 0, 0, 0, Math.PI / 2]] }]) })
  assert.ok(result, stderr)
  for (const component of self.ikArgs.pose.slice(3)) assert.ok(Math.abs(component - 0.5) < 1e-10)
})

test('policy rejects live tool offsets and reserved inference argument overrides', async () => {
  for (const extra of [{ inference_args: { obs: {} } }, {}]) {
    const self = cartesianArm(), model = policy([{ actions: [[0, 0, 0, 0, 0, 0]] }])
    const { result, stderr } = await dialog(tool('run-policy'), {
      model: 'policy', observation: {}, command: [{ device: 'arm', space: 'pose_delta', target_frame: 'arm' }], ...extra,
    }, { arm: self, policy: model })
    assert.equal(result, undefined)
    assert.match(stderr, extra.inference_args ? /cannot override/ : /rigidly attached/)
    assert.equal(self.writes, 0)
  }
})

function clock(arm) {
  return { time: 0, read() { return { time_s: this.time } },
    wait({ duration_s }) { this.time += duration_s; arm.advance(duration_s); return { time_s: this.time, waited_s: duration_s } } }
}

test('servo submits without a world clock when block=false', async () => {
  const armDevice = arm({})
  const { result, stderr } = await dialog(tool('servo'), { device: 'arm', joints: [2, 1], block: false }, { arm: armDevice })
  assert.ok(result, stderr)
  assert.equal(armDevice.writes, 1)
  assert.equal(armDevice.stops, 0)
  assert.equal(armDevice.clock, 0)
  assert.equal(armDevice.history.length, 375)
  assert.deepEqual(armDevice.history.at(-1), [2, 1])
  assert.deepEqual(result, { device: 'arm', execution_id: 'test', joints: [2, 1],
    duration_s: 3.75, actions_submitted: 375 })
  assert.equal(armDevice.pending.duration_s, result.duration_s)
  assert.equal(result.actions_submitted, armDevice.history.length)
})

for (const type of ['joint', 'dexterous_hand']) for (const block of [undefined, true]) test(`servo waits the planned duration for ${type} joints and poses when block=${block}`, async () => {
  for (const goal of [{ joints: [2, 1] }, { pose: [0, 0, 0, 0, 0, 0, 1] }]) {
    const armDevice = arm({ type, ik: [2, 1], rate: .01 }), world = clock(armDevice)
    world.profile = () => ({ type: 'world', loaded: true })
    const clockName = goal.pose ? 'simulation' : 'world'
    const response = await dialog(tool('servo'), { device: 'arm', ...goal, block,
      ...(goal.pose ? { world: clockName } : {}) }, { arm: armDevice, [clockName]: world })
    assert.ok(response.result, response.stderr)
    assert.equal(world.time, response.result.duration_s)
    assert.equal(armDevice.clock, response.result.duration_s)
    assert.equal(armDevice.writes, 1)
    assert.equal(armDevice.reads, 1)
    assert.equal(armDevice.stops, 0)
    // Blocking waits for time, even when the actuator lags the target.
    assert.notDeepEqual(armDevice.positions, response.result.joints)
  }
})

test('servo validates blocking options before replacing motion', async () => {
  const armDevice = arm({})
  const initial = await dialog(tool('servo'), { device: 'arm', block: false, joints: [.2, .1] }, { arm: armDevice })
  assert.ok(initial.result, initial.stderr)
  const pending = armDevice.pending
  for (const block of [null, 0, 1, 'true']) {
    const response = await dialog(tool('servo'), { device: 'arm', joints: [2, 1], block }, { arm: armDevice })
    assert.match(response.stderr, /block must be a boolean/)
    assert.equal(response.result, undefined)
  }
  for (const block of [undefined, true]) for (const world of [undefined, { profile: () => ({ type: 'joint', loaded: true }) },
    { profile: () => ({ type: 'world', loaded: false }) }]) {
    const response = await dialog(tool('servo'), { device: 'arm', joints: [2, 1], block }, { arm: armDevice, world })
    assert.equal(response.result, undefined)
    assert.match(response.stderr, /world/)
  }
  assert.equal(armDevice.writes, 1)
  assert.equal(armDevice.reads, 1)
  assert.equal(armDevice.stops, 0)
  assert.equal(armDevice.pending, pending)
})

test('servo preserves home recovery for pose goals with either blocking mode', async () => {
  for (const sign of [-1, 1]) for (const block of [false, true]) {
    const device = arm({ dof: 1, ik: [0] }), original = device.profile, world = clock(device)
    device.positions = [sign * (3.2 + Math.PI / 180)]
    device.profile = () => ({ ...original(), intrinsics: { ...original().intrinsics, home: { j0: 0 } } })
    world.profile = () => ({ type: 'world', loaded: true })
    const response = await dialog(tool('servo'), { device: 'arm', pose: [0, 0, 0, 0, 0, 0, 1], block },
      { arm: device, world })
    assert.ok(response.result, response.stderr)
    assert.equal(device.reads, 1)
    assert.deepEqual(device.ikArgs.seed, [sign * 3.2])
    assert.ok(Math.abs(device.history[0][0]) > 3.2, 'planning retains the measured overshoot')
    assert.deepEqual(device.history.at(-1), [0])
    assert.equal(world.time, block ? response.result.duration_s : 0)
    assert.equal(device.stops, 0)
  }
})

for (const type of ['joint', 'dexterous_hand']) test(`servo resolves ${type} pose targets through declared IK`, async () => {
  const armDevice = arm({ ik: [0.01, 0.02], type })
  const { result, stderr } = await dialog(tool('servo'), { device: 'arm', block: false, pose: [0, 0, 0, 0, 0, 0, 1] }, { arm: armDevice })
  assert.ok(result, stderr)
  assert.deepEqual(armDevice.history.at(-1), [.01, .02])
  assert.equal(result.duration_s, Math.sqrt(10 / Math.sqrt(3) * .02 / 3))
  assert.equal(armDevice.history.length, Math.ceil(result.duration_s / .01))
  assert.deepEqual(result.joints, [.01, .02])
  assert.deepEqual(armDevice.ikArgs.seed, [0, 0])
  assert.equal(armDevice.reads, 1)
})

test('servo rejects removed arguments without replacing motion', async () => {
  const device = arm({ dof: 1 })
  const initial = await dialog(tool('servo'), { device: 'arm', block: false, joints: [.2] }, { arm: device })
  assert.ok(initial.result, initial.stderr)
  const pending = device.pending
  for (const extra of [{ max_joint_delta: 1 }, { duration_s: 1 }, { ik: {} }]) {
    const rejected = await dialog(tool('servo'), { device: 'arm', block: false, joints: [2], ...extra }, { arm: device })
    assert.equal(rejected.result, undefined)
    assert.match(rejected.stderr, /unsupported servo arguments/)
    assert.equal(device.writes, 1)
    assert.equal(device.stops, 0)
    assert.equal(device.pending, pending)
  }
})

test('servo preserves explicit bounded targets without imposing a travel cap', async () => {
  const device = arm({ dof: 1 })
  device.positions = [3.1]
  const accepted = await dialog(tool('servo'), { device: 'arm', block: false, joints: [-3.1] }, { arm: device })
  assert.ok(accepted.result, accepted.stderr)
  assert.deepEqual(device.history.at(-1), [-3.1])
})

test('servo seeds IK from the same measured state used for planning and projects only the seed', async () => {
  const device = arm({ ik: [3.1, .2] }), profile = device.profile
  device.profile = () => { const value = profile(); value.intrinsics.control.limit_handling = 'native'; return value }
  device.positions = [3.201, .1]
  device.ik = args => {
    assert.equal(device.reads, 1)
    assert.deepEqual(args.seed, [3.2, .1])
    // A second read would observe different positions and change the trajectory.
    device.positions = [0, 0]
    return [3.1, .2]
  }
  const { result, stderr } = await dialog(tool('servo'), { device: 'arm', block: false, pose: [0, 0, 0, 0, 0, 0, 1] }, { arm: device })
  assert.ok(result, stderr)
  assert.equal(device.reads, 1)
  assert.ok(device.history[0][0] > 3.2)
  assert.deepEqual(device.history.at(-1), [3.1, .2])
})

test('servo scales full plans and rejects oversized plans before writing', async () => {
  const device = arm({})
  const { result, stderr } = await dialog(tool('servo'), { device: 'arm', block: false, joints: [2, 1], speedFraction: .5 }, { arm: device })
  assert.ok(result, stderr)
  assert.equal(result.duration_s, 7.5)
  assert.equal(device.history.length, 750)
  assert.deepEqual(device.history.at(-1), [2, 1])
  const pending = device.pending
  const failed = await dialog(tool('servo'), { device: 'arm', block: false, joints: [2, 1], speedFraction: .0001 }, { arm: device })
  assert.equal(failed.result, undefined)
  assert.match(failed.stderr, /one million/)
  assert.equal(device.writes, 1)
  assert.equal(device.pending, pending)
})

test('servo submits wrapped continuous references while returning the requested goal', async () => {
  const device = arm({ dof: 1 }), profile = device.profile
  device.positions = [Math.PI - .1]
  device.profile = () => {
    const value = profile()
    value.resolved_model.joints[0] = { name: 'j0', type: 'continuous', limits: null }
    return value
  }
  const { result, stderr } = await dialog(tool('servo'), { device: 'arm', block: false, joints: [-Math.PI + .1] }, { arm: device })
  assert.ok(result, stderr)
  assert.deepEqual(result.joints, [-Math.PI + .1])
  assert.ok(Math.abs(device.history.at(-1)[0] - (Math.PI + .1)) < 1e-12)
})

test('run_policy flattens end-effector columns and validates the entire chunk before writes', async () => {
  for (const invalid of [false, true]) {
    const armDevice = arm({}), submitted = []
    const gripper = {
      profile: () => ({ type: 'gripper', intrinsics: { control: {
        mode: 'position', bounds: { min: 0, max: 1 }, resolution: null, speed: null,
      } } }),
      write: args => { submitted.push(args); return { execution_id: 'gripper', state: { faults: [] } } },
      stop: () => ({}),
    }
    const model = policy([{ actions: [[.1, .2, .3], [.2, .3, invalid ? 2 : .4]] }])
    const { result, stderr } = await dialog(tool('run-policy'), {
      model: 'policy', observation: {}, command: [{ device: 'arm' }, { device: 'gripper' }], action_hz: 10,
    }, { arm: armDevice, gripper, policy: model })
    if (invalid) {
      assert.match(stderr, /exceeds profile command bounds/)
      assert.equal(armDevice.writes, 0)
      assert.deepEqual(submitted, [])
    } else {
      assert.equal(result?.actions_submitted, 2, stderr)
      assert.deepEqual(submitted, [{ actions: [.3, .4], duration_s: .2 }])
      assert.deepEqual(armDevice.pending, { actions: [[.1, .2], [.2, .3]], duration_s: .2 })
    }
  }
})

test('run_policy submits complete chunks without advancing time', async () => {
  const armDevice = arm({}), model = policy([{ actions: [[.1, .2], [.2, .3]] }])
  const { result, stderr } = await dialog(tool('run-policy'), { model: 'policy', observation: {}, command: [{ device: 'arm' }], action_hz: 20 }, { arm: armDevice, policy: model })
  assert.ok(result, stderr)
  assert.equal(result.actions_submitted, 2)
  assert.equal(result.duration_s, .1)
  assert.equal(result.ik_failure, null)
  assert.equal(armDevice.clock, 0)
  assert.equal(armDevice.stops, 0)
})

test('relative_pose bridges disconnected frames only with supplied estimates', async () => {
  const armDevice = arm({}), camera = arm({})
  const original = camera.profile
  camera.profile = () => ({ ...original(), name: 'camera' })
  const input = { child: { frame: 'camera', pose: [1, 0, 0, 0, 0, 0, 1] }, parent: { frame: 'arm' } }
  const disconnected = await dialog(tool('relative-pose'), input, { arm: armDevice, camera })
  assert.equal(disconnected.result, undefined)
  const { result, stderr } = await dialog(tool('relative-pose'), { ...input, estimates: [
    { child: 'camera', parent: 'arm', translation_m: [0, 1, 0], rotation_xyzw: [0, 0, 1, 0] },
  ] }, { arm: armDevice, camera })
  assert.ok(result, stderr)
  assert.deepEqual(result.pose, [-1, 1, 0, 0, 0, 1, 0])
  assert.equal(result.estimated_links, 1)
  assert.equal(result.path[0].kind, 'estimated')
})


test('servo normalizes rounded pose goals before IK and rejects larger norm errors', async () => {
  const rounded = [.2, 0, .95, .964, .264, .032, .011]
  for (const frame of [undefined, 'arm']) {
    const device = arm({ ik: [.1, .2] })
    const { result, stderr } = await dialog(tool('servo'), { device: 'arm', block: false, pose: rounded, ...(frame ? { frame } : {}) }, { arm: device })
    assert.ok(result, stderr)
    assert.deepEqual(device.ikArgs.pose.slice(0, 3), rounded.slice(0, 3))
    const norm = Math.hypot(...rounded.slice(3))
    device.ikArgs.pose.slice(3).forEach((value, i) => assert.ok(Math.abs(value - rounded[i + 3] / norm) < 1e-12))
    assert.equal(device.writes, 1)
    const far = await dialog(tool('servo'), { device: 'arm', block: false, pose: [.2, 0, .95, 0, 0, 0, 1.002] }, { arm: device })
    assert.equal(far.result, undefined)
    assert.match(far.stderr, /pose requires a unit quaternion \[qx, qy, qz, qw\] \(xyzw\); got norm 1\.002/)
    assert.match(far.stderr, /within 0\.001 of 1/)
    assert.equal(device.writes, 1)
  }
})

test('relative_pose normalizes local poses and estimates within the same norm bounds', async () => {
  const camera = arm({}), original = camera.profile
  camera.profile = () => ({ ...original(), name: 'camera' })
  const devices = { arm: arm({}), camera }
  const input = {
    child: { frame: 'camera', pose: [1, 0, 0, 0, 0, 0, .999] },
    parent: { frame: 'arm', pose: [0, 0, 0, 0, 0, 0, 1.001] },
  }
  const estimate = { child: 'camera', parent: 'arm', translation_m: [0, 1, 0] }
  for (const rotation of [[0, 0, .707, .707], [0, 0, 0, .999], [0, 0, 0, 1.001]]) {
    const { result, stderr } = await dialog(tool('relative-pose'), { ...input,
      estimates: [{ ...estimate, rotation_xyzw: rotation }],
    }, devices)
    assert.ok(result, stderr)
    const norm = Math.hypot(...rotation)
    result.pose.slice(3).forEach((value, i) => assert.ok(Math.abs(value - rotation[i] / norm) < 1e-12))
    const position = rotation[2] ? [0, 2, 0] : [1, 1, 0]
    result.pose.slice(0, 3).forEach((value, i) => assert.ok(Math.abs(value - position[i]) < 1e-12))
    assert.equal(result.estimated_links, 1)
  }
  for (const rotation of [[0, 0, 0, .998], [0, 0, 0, 1.002], [0, 0, 0, 0]]) {
    const rejected = await dialog(tool('relative-pose'), { ...input,
      estimates: [{ ...estimate, rotation_xyzw: rotation }],
    }, devices)
    assert.equal(rejected.result, undefined)
    assert.match(rejected.stderr, /estimates\[0\]\.rotation_xyzw requires a unit quaternion/)
    assert.match(rejected.stderr, /within 0\.001 of 1/)
  }
})

test('policy normalizes near-unit absolute pose actions before frame conversion and IK', async () => {
  for (const rotation of [[0, 0, .707, .707], [0, 0, 0, 1.002]]) {
    const device = cartesianArm()
    const { result, stderr } = await dialog(tool('run-policy'), {
      model: 'policy', observation: {}, command: [{ device: 'arm', space: 'pose' }],
    }, { arm: device, policy: policy([{ actions: [[.1, .2, 0, ...rotation]] }]) })
    if (rotation[2]) {
      assert.ok(result, stderr)
      assert.equal(device.writes, 1)
      assert.equal(result.actions_submitted, 1)
      assert.deepEqual(device.ikArgs.pose.slice(0, 3), [.1, .2, 0])
      assert.ok(Math.abs(device.ikArgs.pose[5] - Math.SQRT1_2) < 1e-12)
      assert.ok(Math.abs(device.ikArgs.pose[6] - Math.SQRT1_2) < 1e-12)
    } else {
      assert.equal(result, undefined)
      assert.match(stderr, /got norm 1\.002/)
      assert.equal(device.solves.length, 0)
      assert.equal(device.writes, 0)
    }
  }
})

test('native servo accepts measured overshoot and explicit targets beyond model bounds', async () => {
  const device = arm({}), original = device.profile
  device.profile = () => { const value = original(); value.intrinsics.control.limit_handling = 'native'; return value }
  device.positions = [3.201, 0]
  const { result, stderr } = await dialog(tool('servo'), { device: 'arm', block: false, joints: [4, 0] }, { arm: device })
  assert.ok(result, stderr)
  assert.equal(device.writes, 1)
  assert.deepEqual(result.joints, [4, 0])
})

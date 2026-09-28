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

function arm({ dof = 2, rate = 1, ik = null }) {
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
    efforts: [], faults: [], sample_time_s: self.clock,
  })
  self.read = () => { self.reads++; return snapshot() }
  self.write = (args) => {
    self.writes++
    self.history.push(...args.actions.map(q => [...q]))
    self.pending = args
    return { execution_id: 'test', elapsed_s: 0, state: snapshot() }
  }

  self.advance = seconds => { if (self.pending) self.target = self.pending.actions.at(-1); advance(seconds) }
  self.stop = () => { self.pending = null; self.stops++; self.target = [...self.positions]; return { stopped: true } }
  self.profile = () => ({
    name: 'arm', type: 'joint', loaded: true,
    resolved_model: { joints: self.positions.map((_, i) => ({ name: `j${i}`, type: 'revolute', limits: { min: -3.2, max: 3.2 }, max_velocity: 2 })), chain: null },
    intrinsics: {
      control: { mode: 'position' },
      feedback: { velocities: true, clock: 'simulation' },
      kinematics: { ik: 'numerical', frame: 'flange' }, frames: {},
    },
  })
  return self
}

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
    const proc = spawn(python, [file, JSON.stringify(callArgs)], {
      env: { ...process.env, KINEX_TOOL_DIALOG: '1', PYTHONPATH: pythonLib },
    })
    let stderr = '', done = false
    proc.stderr.on('data', (chunk) => { stderr += chunk })
    const act = (device, action, args) => {
      if (action === 'wait') return { ok: true, data: device.wait(args) }
      if (action === 'read') return { ok: true, data: device.read() }
      if (action === 'write') { owned.add(device); return { ok: true, data: device.write(args) } }
      if (action === 'stop') return { ok: true, data: device.stop() }
      if (action === 'ik') { device.ikArgs = args; return { ok: true, data: { joints: typeof device.ik === 'function' ? device.ik(args) : device.ik } } }
      if (action === 'fk') return { ok: true, data: { pose: [0, 0, 0, 0, 0, 0, 1] } }
      if (action === 'infer') return { ok: true, data: device.infer(args) }
      return { ok: false, error: `no action ${action}` }
    }
    const reply = (value) => proc.stdin.write(JSON.stringify(value) + '\n')
    createInterface({ input: proc.stdout }).on('line', (line) => {
      let message
      try { message = JSON.parse(line) } catch { return }
      if ('return' in message) { done = true; resolve({ result: message.return, stderr }); proc.stdin.end(); return }
      if ('error' in message) { done = true; resolve({ error: message.error, stderr }); proc.stdin.end(); return }
      const { call } = message
      if (call === 'stop_owned') {
        for (const device of owned) device.stop()
        return reply({ ok: true })
      }
      if (call === 'profile') return reply({ ok: true, profile: devices[message.device]?.profile() ?? null })
      if (call === 'device') return reply(act(devices[message.device], message.action ?? 'read', message.args ?? {}))
      if (call === 'devices') return reply({ ok: true, results: message.commands.map((c) => ({
        device: c.device, ...act(devices[c.device], c.action ?? 'read', c.args ?? {}) })) })
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
  device.profile = () => { const p = prof(); p.intrinsics.frames.camera = [1, 2, 3, 0, 0, q, q]; return p }
  const child = { frame: 'arm:camera', pose: [1, 0, 0, 1, 0, 0, 0] }
  const parent = { frame: 'arm', pose: [1, 1, 1, 0, 0, q, q] }
  const near = (actual, expected) => actual.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < 1e-9, `${actual} != ${expected}`))
  for (const [a, b, expected] of [[child, parent, [2, 0, 2, 1, 0, 0, 0]], [parent, child, [-2, 0, 2, 1, 0, 0, 0]]]) {
    const { result, stderr } = await dialog(tool('relative-pose'), { child: a, parent: b }, { arm: device })
    assert.ok(result, stderr)
    near(result.pose, expected)
    assert.deepEqual(result.pose, [...result.translation, ...result.rotation])
    assert.equal(result.estimated_links, 0)
  }
  const identity = await dialog(tool('relative-pose'), { child: { frame: 'arm' }, parent: { frame: 'arm' } }, { arm: device })
  near(identity.result.pose, [0, 0, 0, 0, 0, 0, 1])
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
  const originalProfile = self.profile, originalRead = self.read
  self.profile = () => ({ ...originalProfile(),
    intrinsics: { ...originalProfile().intrinsics, frames: { flange: null } },
    extrinsics: { mount: { parent: 'world', parent_frame: 'world', translation_m: [1, 0, 0], rotation_xyzw: [0, 0, 0, 1] } },
  })
  self.read = () => ({ ...originalRead(), frame_poses: { flange: [0, 0, 0, 0, 0, 0, 1] } })
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

test('policy rejects a failed later IK solution before admitting any writes', async () => {
  const self = cartesianArm()
  self.ik = args => { self.solves.push(args); return self.solves.length === 2 ? null : [0.1, 0] }
  const { result, stderr } = await dialog(tool('run-policy'), {
    model: 'policy', observation: {}, command: [{ device: 'arm', space: 'pose_delta' }],
  }, { arm: self, policy: policy([{ actions: Array(2).fill([0.1, 0, 0, 0, 0, 0]) }]) })
  assert.equal(result, undefined)
  assert.match(stderr, /IK result/)
  assert.equal(self.writes, 0)
  assert.equal(self.stops, 0)
})

test('policy rotation deltas use reference axes rather than rotating tool axes', async () => {
  const self = cartesianArm(), read = self.read
  self.read = () => ({ ...read(), frame_poses: { flange: [0, 0, 0, Math.SQRT1_2, 0, 0, Math.SQRT1_2] } })
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
    wait({ duration_s }) { this.time += duration_s; arm.advance(duration_s); return { time_s: this.time, elapsed_s: duration_s } } }
}
const tracking = { world: 'world', wait_s: 0.1, max_rounds: 3,
  perceive: { tool: 'target' }, process: { tool: 'process' },
  control: { tool: 'servo', args: { device: 'arm', duration_s: 0.2 } },
  until: { tool: 'done' } }
const stages = { target: () => ({ joints: [0.2, 0.1] }), process: ({ observation }) => observation, done: () => ({ done: false }) }

test('servo submits a bounded trajectory without waiting or stopping', async () => {
  const armDevice = arm({})
  const { result, stderr } = await dialog(tool('servo'), { device: 'arm', joints: [2, 1], duration_s: .13 }, { arm: armDevice })
  assert.ok(result, stderr)
  assert.equal(armDevice.writes, 1)
  assert.equal(armDevice.stops, 0)
  assert.equal(armDevice.clock, 0)
  assert.equal(armDevice.history.length, 13)
  assert.ok(armDevice.history.at(-1)[0] < 2)
  assert.deepEqual(result.joints, [2, 1])
})

test('servo resolves pose targets through IK and pads short moves', async () => {
  const armDevice = arm({ ik: [0.01, 0.02] })
  const { result, stderr } = await dialog(tool('servo'), { device: 'arm', pose: [0, 0, 0, 0, 0, 0, 1], duration_s: 2 }, { arm: armDevice })
  assert.ok(result, stderr)
  assert.deepEqual(armDevice.history.at(-1), [.01, .02])
  assert.equal(armDevice.history.length, 200)
})

test('track waits after submission and optionally stops before until', async () => {
  for (const stop_after_control of [false, true]) {
    const armDevice = arm({}), world = clock(armDevice), observed = []
    const { result, stderr } = await dialog(tool('track'), { ...tracking, stop_after_control }, { arm: armDevice, world }, {
      ...stages, done: ({ context, state }) => { observed.push([context.round, world.time, armDevice.stops]); return { done: false, state: (state ?? 0) + 1 } },
    })
    assert.ok(result, stderr)
    assert.equal(result.rounds, 3)
    assert.equal(result.until_state, 4)
    assert.equal(armDevice.writes, 3)
    assert.equal(armDevice.stops, stop_after_control ? 4 : 1)
    assert.ok(Math.abs(world.time - .3) < 1e-9)
    assert.deepEqual(observed.map(row => row[2]), stop_after_control ? [0, 1, 2, 3] : [0, 0, 0, 0])
  }
})

test('track waits on misses, resets consecutive misses and propagates predicate state', async () => {
  const armDevice = arm({}), world = clock(armDevice)
  let rounds = 0
  const { result, stderr } = await dialog(tool('track'), { ...tracking, max_rounds: 6, max_misses: 2 }, { arm: armDevice, world }, {
    ...stages, process: ({ observation }) => ++rounds === 2 ? observation : null,
  })
  assert.ok(result, stderr)
  assert.equal(result.terminated_by, 'perception_lost')
  assert.equal(result.rounds, 4)
  assert.equal(armDevice.writes, 1)
  assert.equal(world.time, .4)
})

test('track propagates stage failures and stops owned motion', async () => {
  const armDevice = arm({}), world = clock(armDevice)
  let rounds = 0
  const { result, stderr } = await dialog(tool('track'), tracking, { arm: armDevice, world }, {
    ...stages, process: ({ observation }) => { if (++rounds === 2) throw Error('processing failed'); return observation },
  })
  assert.equal(result, undefined)
  assert.match(stderr, /processing failed/)
  assert.equal(armDevice.stops, 1)
})

test('settled persists stable time across fresh tool processes and resets on goal changes', async () => {
  const armDevice = arm({}), world = clock(armDevice)
  let state = null
  const check = async (time, joints = [0, 0]) => {
    const out = await dialog(tool('settled'), { context: { time_s: time, world: 'world', control_result: { device: 'arm', joints } }, state }, { arm: armDevice, world })
    assert.ok(out.result, out.stderr)
    state = out.result.state
    return out.result.done
  }
  assert.equal(await check(0), false)
  assert.equal(await check(.05), false)
  assert.equal(await check(.1), true)
  assert.equal(await check(.2, [.1, 0]), false)
  assert.equal(state.since_s, null)
})

test('settled uses world time for timeout even without a resolved target', async () => {
  const first = await dialog(tool('settled'), { context: { time_s: 3 }, timeout_s: 1 }, {})
  const next = await dialog(tool('settled'), { context: { time_s: 4 }, state: first.result.state, timeout_s: 1 }, {})
  assert.equal(next.result.reason, 'timeout')
})

test('run_policy flattens end-effector columns and validates the entire chunk before writes', async () => {
  for (const invalid of [false, true]) {
    const armDevice = arm({}), submitted = []
    const gripper = {
      profile: () => ({ type: 'gripper', intrinsics: { control: {
        mode: 'position', bounds: { min: 0, max: 1 }, resolution: null, speed: null,
      } } }),
      write: args => { submitted.push(args); return { execution_id: 'gripper', elapsed_s: 0, state: { faults: [] } } },
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
  assert.equal(armDevice.clock, 0)
  assert.equal(armDevice.stops, 0)
})

test('track maps a measured pose through relative_pose into servo', async () => {
  const device = arm({ ik: [0.1, 0.2] }), prof = device.profile, world = clock(device)
  device.profile = () => { const p = prof(); p.intrinsics.frames.camera = [1, 2, 3, 0, 0, 0, 1]; return p }
  const options = { ...tracking, max_rounds: 1,
    process: { tool: 'relative_pose', args: { parent: { frame: 'arm' } },
      inputs: { '/child/frame': '/frame', '/child/pose': '/poses/0' } },
    control: { ...tracking.control, inputs: { '/pose': '/pose' } } }
  const { result, stderr } = await dialog(tool('track'), options, { arm: device, world }, {
    ...stages, target: () => ({ frame: 'arm:camera', poses: [[0.1, 0.2, 0.3, 0, 0, 1, 0]] }) })
  assert.ok(result, stderr)
  assert.deepEqual(device.ikArgs.pose, [1.1, 2.2, 3.3, 0, 0, 1, 0])
  assert.equal(world.time, 0.1)
  assert.equal(device.writes, 1)
  assert.equal(device.stops, 1)
})

test('track input mapping handles array destinations, escaped keys, nulls and missing paths', async () => {
  for (const mode of ['valid', 'null', 'missing', 'invalid']) {
    const device = arm({}), world = clock(device)
    const { result, stderr } = await dialog(tool('track'), { ...tracking, max_rounds: 1, max_misses: 1,
      process: { tool: 'process', args: { retained: true }, inputs: { '/values/0': '/a~1b/~0key' } },
      control: { ...tracking.control, inputs: { '/joints': mode === 'missing' ? '/missing' : '/goal' } },
    }, { arm: device, world }, { ...stages,
      target: () => ({ 'a/b': { '~key': mode === 'null' ? null : [0.2, 0.1] } }),
      process: args => { assert.deepEqual(args, { retained: true, values: [[0.2, 0.1]] }); return mode === 'invalid' ? [] : { goal: args.values[0], ignored: true } },
    })
    if (mode === 'valid') { assert.ok(result, stderr); assert.equal(device.writes, 1) }
    else if (mode === 'null') { assert.equal(result.terminated_by, 'perception_lost'); assert.equal(device.writes, 0) }
    else { assert.equal(result, undefined); assert.match(stderr, mode === 'missing' ? /missing input path/ : /dict or null/); assert.equal(device.writes, 0) }
  }
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

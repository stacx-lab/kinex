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

// The same buffered interface, with mode-specific terminal references.
function arm({ background, dof = 2, rate = 1, ik = null, stall = false }) {
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
    const period = 1 / args.freq_hz
    let elapsed = 0, completed = 0
    for (const target of args.actions) {
      const duration = Math.min(period, (args.for_s ?? Infinity) - elapsed)
      if (duration <= 1e-9) break
      self.history.push([...target])
      self.target = [...target]
      if (!stall) advance(duration)
      elapsed += duration
      if (duration < period - 1e-9) break
      completed++
    }
    if (!background || completed < args.actions.length) self.stop()
    return { completed_actions: completed, elapsed_s: elapsed,
      terminated_by: completed < args.actions.length ? 'timeout' : 'completed', state: snapshot() }
  }

  self.stop = () => { self.stops++; self.target = [...self.positions]; return { stopped: true } }
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

const GOAL = [0.5, -0.3]
const move = (device, extra = {}) =>
  dialog(tool('move-to'), { device: 'arm', joints: GOAL, timeout_s: 10, ...extra }, { arm: device })

test('identical arguments produce identical motion however the world advances', async () => {
  const outcomes = {}
  for (const background of [true, false]) {
    const device = arm({ background })
    const { result, error, stderr } = await move(device)
    assert.equal(error, undefined, stderr)
    assert.equal(result.terminated_by, 'reached')
    assert.deepEqual(result.state.positions.map((v) => Number(v.toFixed(3))), GOAL)
    assert.ok(device.stops >= 1)
    outcomes[background ? 'background' : 'stepped'] = { result, device }
  }
  const [live, stepped] = [outcomes.background, outcomes.stepped]
  // The same goal costs the same device time on both...
  assert.ok(Math.abs(live.result.elapsed_s - stepped.result.elapsed_s) < 0.05,
    `device elapsed diverged: ${live.result.elapsed_s} vs ${stepped.result.elapsed_s}`)
  // Both clocks use the same upper-layer motion loop.
  assert.equal(live.result.rounds, 1)
  assert.equal(stepped.result.rounds, 1)
})

test('a pose goal is solved by the device IK driver', async () => {
  for (const background of [true, false]) {
    const device = arm({ background, ik: GOAL })
    const { result, error, stderr } = await move(device, { joints: undefined, pose: [0.4, -0.2, 0, 0, 0, 0, 1] })
    assert.equal(error, undefined, stderr)
    assert.equal(result.reached, true)
  }
})

test('a device that reports no progress ends the run instead of spinning', async () => {
  const device = arm({ background: false, stall: true })
  const { result } = await move(device)
  assert.equal(result.terminated_by, 'timeout')
  assert.ok(device.stops >= 1)
})


test('track passes arbitrary perception through processing and keeps controller results opaque', async () => {
  const seen = [], controls = [], processed = []
  const { result, error, stderr } = await dialog(tool('track'), {
    perceive: { tool: 'detect', args: { prompt: 'mug' } },
    process: { tool: 'convert', args: { scale: 2, observation: { stale: true } } },
    control: { tool: 'custom', args: { device: 'arm', target: -1, duration_s: 0.3 } },
    until: { tool: 'done' },
  }, {}, {
    detect: a => { seen.push(a); return { coordinate: seen.length } },
    convert: a => { processed.push(a); return { args: { target: a.observation.coordinate * a.scale } } },
    custom: a => { controls.push(a); return { custom_result: controls.length, reached: true } },
    done: () => ({ done: controls.length === 3 }),
  })
  assert.equal(error, undefined, stderr)
  assert.deepEqual(result, { terminated_by: 'until:done', rounds: 3, perception_misses: 0,
    last: { custom_result: 3, reached: true } })
  assert.deepEqual(seen, Array(3).fill({ prompt: 'mug' }))
  assert.deepEqual(processed[0], { scale: 2, observation: { coordinate: 1 } })
  assert.deepEqual(controls, [2, 4, 6].map(target => ({ device: 'arm', target, duration_s: 0.3 })))
})

test('track leaves timing to its controller and resets consecutive misses', async () => {
  let round = 0
  const controls = []
  const { result, stderr } = await dialog(tool('track'), {
    perceive: { tool: 'p' }, process: { tool: 'convert' },
    control: { tool: 'custom', args: { timeout_s: 0.5 } }, max_rounds: 6, max_misses: 2,
  }, {}, {
    p: () => ({ seen: ++round % 2 === 0 }),
    convert: a => ({ args: a.observation.seen ? {} : null }),
    custom: a => { controls.push(a); return { terminated_by: 'timeout' } },
  })
  assert.ok(result, stderr)
  assert.equal(result.terminated_by, 'max_rounds')
  assert.equal(result.perception_misses, 0)
  assert.deepEqual(controls, Array(3).fill({ timeout_s: 0.5 }))
})

test('track retries processing misses without commanding or stopping unowned devices', async () => {
  let attempts = 0, commanded = 0
  const device = arm({ background: true })
  const { result, stderr } = await dialog(tool('track'), {
    perceive: { tool: 'p' }, process: { tool: 'point_to_pose', args: { device: 'arm' } },
    control: { tool: 'custom' }, max_misses: 3,
  }, { arm: device }, {
    p: () => { attempts++; return { point: null } },
    custom: () => { commanded++; return {} },
  })
  assert.ok(result, stderr)
  assert.equal(result.terminated_by, 'perception_lost')
  assert.equal(attempts, 3)
  assert.equal(commanded, 0)
  assert.equal(device.stops, 0)
})

test('a policy chunk replays at one action_hz period per action', async () => {
  const chunk = [[0.1, 0.1], [0.2, 0.2], [0.3, 0.3]]
  const outcomes = {}
  for (const background of [true, false]) {
    const device = arm({ background })
    const model = policy([{ actions: chunk, done: true }])
    const { result, error, stderr } = await dialog(
      tool('run-policy'),
      { model: 'policy', observation: { devices: {} }, command: [{ device: 'arm' }],
        action_hz: 10, timeout_s: 20 },
      { arm: device, policy: model },
    )
    assert.equal(error, undefined, `background=${background}: ${stderr}`)
    assert.equal(result.terminated_by, 'done')
    assert.equal(result.actions_executed, 3)
    assert.deepEqual(device.history.at(-1), [0.3, 0.3], 'the final action must reach the device')
    assert.equal(device.stops, background ? 0 : 1)
    outcomes[background ? 'background' : 'stepped'] = { result, device }
  }
  // Three actions at 10 Hz is 0.3 s of robot time whoever advances the clock...
  for (const key of ['background', 'stepped'])
    assert.ok(Math.abs(outcomes[key].result.elapsed_s - 0.3) < 1e-6, `${key}: ${outcomes[key].result.elapsed_s}`)
  // One buffered RPC per device, regardless of clock mode.
  assert.equal(outcomes.background.device.writes, 1)
  assert.equal(outcomes.stepped.device.writes, 1)
})

test('track runs policy chunks and stops every owned device on a miss and final exit', async () => {
  const first = arm({ background: true }), second = arm({ background: true })
  const model = policy([{ actions: [[0.2, 0.2, 0.3, 0.3]], done: true }])
  let perceptions = 0
  const { result, stderr } = await dialog(tool('track'), {
    perceive: { tool: 'observe' }, process: { tool: 'convert' },
    control: { tool: 'run_policy', args: { model: 'policy', command: [{ device: 'arm' }, { device: 'hand' }], timeout_s: 1 } },
    max_misses: 2,
  }, { arm: first, hand: second, policy: model }, {
    observe: () => {
      perceptions++
      if (perceptions === 2) assert.equal(first.stops, 0, 'retain controller behavior between rounds')
      if (perceptions === 3) assert.ok(first.stops > 0 && second.stops > 0, 'stop before retrying a miss')
      return { available: perceptions === 1, image: 'frame.png' }
    },
    convert: a => ({ args: a.observation.available ? { observation: a.observation } : null }),
  })
  assert.ok(result, stderr)
  assert.equal(result.terminated_by, 'perception_lost')
  assert.equal(result.last.terminated_by, 'done', 'policy completion does not end tracking')
  assert.equal(model.calls, 1)
  assert.equal(model.seen[0].obs.image, 'frame.png')
  assert.equal(first.stops, 3)
  assert.equal(second.stops, 3)
})

function base(background, { stall = false, reached = true } = {}) {
  const self = { clock: 0, writes: [], stops: 0 }
  self.profile = () => ({ type: 'velocity', intrinsics: {
    control: { mode: 'motion', modes: { walk: { posture: null, velocity: { frame: 'body', components: [
      { axis: 'vx', units: 'm/s', bounds: { min: -1, max: 1 } },
    ] } } } }, feedback: { pose_frame: null, velocity_components: ['vx'] },
  } })
  self.read = () => ({ faults: [], pose: null, velocities: [0], sample_time_s: self.clock })
  self.write = args => {
    self.writes.push(args)
    const spent = stall ? 0 : background ? args.for_s : Math.min(0.02, args.for_s)
    self.clock += spent
    return { accepted: true, elapsed_s: spent, reached, state: self.read() }
  }
  self.stop = () => { self.stops++; return { stopped: true } }
  return self
}

const drive = (device, extra = {}, tools = {}) => dialog(tool('drive'), {
  device: 'base', mode: 'walk', velocity: { vx: 0.4 }, duration_s: 0.25, ...extra,
}, { base: device }, tools)

test('drive holds the full duration despite arrival reports, in both clocks', async () => {
  for (const background of [true, false]) {
    const device = base(background)
    const { result, stderr } = await drive(device)
    assert.ok(result, stderr)
    assert.equal(result.terminated_by, 'duration')
    assert.ok(Math.abs(result.elapsed_s - 0.25) < 1e-9)
    assert.equal(device.stops, 1)
    assert.ok(device.writes.every(a => a.velocity.vx === 0.4 && a.for_s > 0))
    assert.equal(device.writes.length, background ? 1 : 13)
  }
})

test('until is checked initially, between bounded writes, and at the final boundary', async () => {
  for (const background of [true, false]) {
    for (const trigger of [0, 0.1, 0.25, Infinity]) {
      const device = base(background)
      const checks = []
      const { result, stderr } = await drive(device, { until: { tool: 'contact', every_s: 0.1 } }, {
        contact: () => { checks.push(device.clock); return { done: device.clock + 1e-9 >= trigger } },
      })
      assert.ok(result, stderr)
      assert.equal(result.terminated_by, trigger === Infinity ? 'duration' : 'until:contact')
      assert.ok(Math.abs(result.elapsed_s - Math.min(trigger, 0.25)) < 1e-9)
      assert.equal(checks[0], 0)
      assert.equal(device.stops, 1)
      assert.ok(device.writes.every(a => a.for_s <= 0.1 + 1e-9))
    }
  }
})


test('point_to_pose transforms points, offsets and orientation without commanding', async () => {
  const device = arm({ background: true })
  const prof = device.profile
  device.profile = () => { const p = prof(); p.intrinsics.frames.camera = [1, 2, 3, 0, 0, 0, 1]; return p }
  for (const orientation of [undefined, [0, 0, 1, 0]]) {
    const { result, stderr } = await dialog(tool('point-to-pose'), {
      device: 'arm', observation: { point: [0.1, 0, 0], frame: 'unused' }, frame: 'arm:camera',
      offset_m: [0, 0.2, 0], ...(orientation ? { orientation } : {}),
    }, { arm: device })
    assert.ok(result, stderr)
    assert.deepEqual(result.args, { pose: [1.1, 2.2, 3, ...(orientation ?? [0, 0, 0, 1])], frame: 'arm' })
  }
  assert.equal(device.reads, 1, 'only default orientation needs a joint reading')
  assert.equal(device.writes, 0)
  assert.equal(device.stops, 0)
  const invalid = await dialog(tool('point-to-pose'), { device: 'arm', observation: { point: [1, 0, 0] } }, { arm: device })
  assert.equal(invalid.result, undefined)
  assert.match(invalid.stderr, /names no frame/)
})

test('move_to accepts a pose frame and raises on disturbed final velocity', async () => {
  const device = arm({ background: true, ik: GOAL })
  const prof = device.profile
  device.profile = () => { const p = prof(); p.intrinsics.frames.camera = [1, 2, 3, 0, 0, 0, 1]; return p }
  const original = device.read
  device.read = () => ({ ...original(), velocities: [5, 0] })
  const { result, stderr } = await move(device, {
    joints: undefined, pose: [0.1, 0, 0, 0, 0, 0, 1], frame: 'arm:camera',
  })
  assert.equal(result, undefined)
  assert.match(stderr, /arm: disturbed/)
  assert.deepEqual(device.ikArgs.pose, [1.1, 2, 3, 0, 0, 0, 1])
  assert.ok(device.stops >= 1)
})

test('track processes points into actual move_to segments with controller-owned timing', async () => {
  for (const background of [true, false]) {
    const device = arm({ background, ik: [3, -3] })
    const { result, stderr } = await dialog(tool('track'), {
      perceive: { tool: 'point' },
      process: { tool: 'point_to_pose', args: { device: 'arm', orientation: [0, 0, 0, 1] } },
      control: { tool: 'move_to', args: { device: 'arm', timeout_s: 0.2 } }, max_rounds: 2,
    }, { arm: device }, { point: () => ({ point: [1, 0, 0], frame: 'arm' }) })
    assert.ok(result, stderr)
    assert.equal(result.terminated_by, 'max_rounds')
    assert.equal(result.rounds, 2)
    assert.ok(Math.abs(device.clock - 0.4) < 1e-9)
    assert.deepEqual(device.ikArgs.pose, [1, 0, 0, 0, 0, 0, 1])
    assert.ok(device.stops >= 2)
  }
})

test('track supports drive durations without interpreting reached', async () => {
  const device = base(true)
  const { result, stderr } = await dialog(tool('track'), {
    perceive: { tool: 'heading' }, process: { tool: 'convert' },
    control: { tool: 'drive', args: { device: 'base', mode: 'walk', duration_s: 0.2 } }, max_rounds: 2,
  }, { base: device }, {
    heading: () => ({ forward: 0.1 }),
    convert: a => ({ args: { velocity: { vx: a.observation.forward } } }),
  })
  assert.ok(result, stderr)
  assert.equal(result.rounds, 2)
  assert.equal(result.last.reached, true)
  assert.ok(Math.abs(device.clock - 0.4) < 1e-9)
  assert.ok(device.stops >= 3)
})

test('policy faults stop commanded devices after their buffered calls settle', async () => {
  const first = arm({ background: true }), second = arm({ background: true })
  const write = second.write
  second.write = a => { const r = write(a); r.state.faults = [{ code: 'overload' }]; return r }
  const { result, stderr } = await dialog(tool('run-policy'), {
    model: 'policy', observation: {}, command: [{ device: 'arm' }, { device: 'hand' }],
    action_hz: 10, timeout_s: 2,
  }, { arm: first, hand: second, policy: policy([{ actions: [[0.1, 0.1, 0.1, 0.1], [0.2, 0.2, 0.2, 0.2]], done: true }]) })
  assert.equal(result, undefined)
  assert.match(stderr, /fault: hand/)
  assert.ok(first.stops >= 1)
  assert.ok(second.stops >= 1)
})

test('shipped driver wrappers enforce budgets and preserve vendor execution results', async () => {
  const { execFileSync } = await import('node:child_process')
  execFileSync(python, [path.join(root, 'test/driver_contract.py')], {
    env: { ...process.env, PYTHONPATH: pythonLib }, encoding: 'utf8',
  })
})

test('track rejects malformed processing and propagates stage failures after stopping owned motion', async () => {
  for (const failure of ['perceive', 'process', 'control', 'until', null, [], {}, { args: [] }, { args: 1 }]) {
    const device = arm({ background: true })
    const model = policy([{ actions: [[0.1, 0.1]] }])
    let rounds = 0
    const { result, stderr } = await dialog(tool('track'), {
      perceive: { tool: 'p' }, process: { tool: 'convert' },
      control: { tool: failure === 'control' ? 'custom' : 'run_policy', args: {
        model: 'policy', command: [{ device: 'arm' }], timeout_s: 1,
      } }, until: { tool: 'done' }, max_rounds: 3,
    }, { arm: device, policy: model }, {
      p: () => { if (++rounds > 1 && failure === 'perceive') throw Error('perception failed'); return {} },
      convert: () => {
        if (rounds > 1 && failure === 'process') throw Error('processing failed')
        if (rounds > 1 && typeof failure === 'object') return failure
        return { args: { observation: {} } }
      },
      custom: () => { throw Error('control failed') },
      done: () => { if (rounds > 0 && failure === 'until') throw Error('predicate failed'); return { done: false } },
    })
    assert.equal(result, undefined)
    assert.match(stderr, /failed|process must return/)
    assert.equal(device.stops, failure === 'control' ? 0 : 1)
  }
})

test('track checks its predicate before any stage', async () => {
  const { result, stderr } = await dialog(tool('track'), {
    perceive: { tool: 'unused' }, process: { tool: 'unused' }, control: { tool: 'unused' },
    until: { tool: 'done', key: 'ready' },
  }, {}, { done: () => ({ ready: true }) })
  assert.ok(result, stderr)
  assert.deepEqual(result, { terminated_by: 'until:done', rounds: 0, perception_misses: 0, last: null })
})

test('move_to timeout always stops, with a bounded number of RPC calls', async () => {
  for (const background of [true, false]) {
    const device = arm({ background })
    const { result, stderr } = await move(device, { joints: [3, -3], timeout_s: 0.2 })
    assert.ok(result, stderr)
    assert.equal(result.terminated_by, 'timeout')
    assert.ok(Math.abs(result.elapsed_s - 0.2) < 1e-8)
    assert.ok(device.stops >= 1)
    assert.equal(device.writes, 2)
    assert.deepEqual(device.target, device.positions)
  }
})

test('policy validates every point before submitting its chunk', async () => {
  const device = arm({ background: true })
  const { result, stderr } = await dialog(tool('run-policy'), {
    model: 'policy', command: [{ device: 'arm' }], observation: {},
  }, { arm: device, policy: policy([{ actions: [[0.1, 0.1], [99, 0]] }]) })
  assert.equal(result, undefined)
  assert.match(stderr, /limits/)
  assert.equal(device.writes, 0)
})

test('policy timeout stops the group without starting the next action', async () => {
  const device = arm({ background: true })
  const { result, stderr } = await dialog(tool('run-policy'), {
    model: 'policy', command: [{ device: 'arm' }], observation: {}, action_hz: 10, timeout_s: 0.2,
  }, { arm: device, policy: policy([{ actions: [[1, 1], [2, 2], [3, 3]] }]) })
  assert.ok(result, stderr)
  assert.equal(result.terminated_by, 'timeout')
  assert.equal(result.actions_executed, 2)
  assert.deepEqual(device.history.at(-1), [2, 2])
  assert.ok(device.stops >= 1)
})

test('quiet arrival without measured velocities fails before motion', async () => {
  const device = arm({ background: true }), profile = device.profile
  device.profile = () => { const p = profile(); p.intrinsics.feedback.velocities = false; return p }
  const { result, stderr } = await move(device)
  assert.equal(result, undefined)
  assert.match(stderr, /measured velocities/)
  assert.equal(device.writes, 0)
})


test('move_to raises faults and zero-progress failures after stopping', async () => {
  for (const reason of ['fault', 'stalled']) {
    const device = arm({ background: true })
    const write = device.write
    device.write = args => {
      const result = write(args)
      if (reason === 'fault') result.state.faults = [{ code: 'overload' }]
      else { result.elapsed_s = 0; result.terminated_by = 'completed' }
      return result
    }
    const { result, stderr } = await move(device)
    assert.equal(result, undefined)
    assert.match(stderr, new RegExp(`arm: ${reason}`))
    assert.ok(device.stops >= 1)
  }
})

test('drive raises faults and stalls after stopping', async () => {
  for (const reason of ['fault', 'stalled']) {
    const device = base(true, { stall: reason === 'stalled' })
    if (reason === 'fault') device.read = () => ({ faults: [{ code: 'overload' }], sample_time_s: device.clock })
    const { result, stderr } = await drive(device)
    assert.equal(result, undefined)
    assert.match(stderr, new RegExp(`base: ${reason}`))
    assert.equal(device.stops, 1)
  }
})

function cartesianArm() {
  const self = arm({ background: false })
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

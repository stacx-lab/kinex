// The controller engine's contract: a write sets the goal, executes it, and
// reports the simulator time it spent. The loop is the same code whether one
// call covers the whole motion or one control interval; only the number of
// rounds differs, and a round costs exactly one round trip.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

const root = fileURLToPath(new URL('../', import.meta.url))
const pythonLib = path.join(root, 'assets', 'python')
const toolDir = path.join(root, 'assets', 'builtin', 'tool')
const python = process.env.PYTHON ?? 'python3'
const tool = (name) => path.join(toolDir, name, 'tool.py')

// A joint device that executes its own goal. `background` models a world that
// advances on a clock of its own — one call spends the whole motion — against
// one that advances inside the write, spending a single interval per call.
// Both publish the SAME profile: nothing in it says which, and nothing reads it.
function arm({ background, interval = 0.02, dof = 2, rate = 1, ik = null, refuse = false, stall = false }) {
  const self = {
    positions: Array(dof).fill(0), target: Array(dof).fill(0), clock: 0,
    writes: 0, reads: 0, stops: 0, history: [], ik,
  }
  const at = (tolerance) => self.positions.every((p, i) => Math.abs(self.target[i] - p) <= tolerance[i])
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
    self.history.push([...args.target])
    self.target = [...args.target]
    if (refuse) return { accepted: false }
    const tolerance = args.arrive?.joint_tolerance ?? self.positions.map(() => 0.01)
    const budget = args.for_s
    let spent
    if (stall) spent = 0
    else if (!background) spent = Math.min(interval, budget)
    else {
      // Time this world needs to close the largest remaining gap.
      const need = Math.max(...self.positions.map((p, i) => Math.abs(self.target[i] - p))) / rate
      spent = Math.min(need, budget)
    }
    advance(spent)
    return { accepted: true, elapsed_s: spent, reached: at(tolerance), state: snapshot() }
  }
  self.stop = () => { self.stops++; self.target = [...self.positions]; return { stopped: true } }
  self.profile = () => ({
    name: 'arm', type: 'joint', loaded: true,
    resolved_model: { joints: self.positions.map((_, i) => ({ name: `j${i}`, type: 'revolute', limits: { min: -3.2, max: 3.2 }, max_velocity: 2 })), chain: null },
    intrinsics: {
      control: { mode: 'position', speed: null },
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
function dialog(file, callArgs, devices, tools = {}) {
  return new Promise((resolve) => {
    const proc = spawn(python, [file, JSON.stringify(callArgs)], {
      env: { ...process.env, KINEX_TOOL_DIALOG: '1', PYTHONPATH: pythonLib },
    })
    let stderr = '', done = false
    proc.stderr.on('data', (chunk) => { stderr += chunk })
    const act = (device, action, args) => {
      if (action === 'read') return { ok: true, data: device.read() }
      if (action === 'write') return { ok: true, data: device.write(args) }
      if (action === 'stop') return { ok: true, data: device.stop() }
      if (action === 'ik') { device.ikArgs = args; return { ok: true, data: { joints: device.ik } } }
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
      if (call === 'profile') return reply({ ok: true, profile: devices[message.device].profile() })
      if (call === 'device') return reply(act(devices[message.device], message.action ?? 'read', message.args ?? {}))
      if (call === 'devices') return reply({ ok: true, results: message.commands.map((c) => ({
        device: c.device, ...act(devices[c.device], c.action ?? 'read', c.args ?? {}) })) })
      if (call === 'tool') {
        // Compose real builtin tools recursively, as python-runner.ts does, so a
        // composition test exercises the actual tools rather than stand-ins.
        const stub = tools[message.name]
        if (stub) return reply({ ok: true, result: stub(message.args ?? {}) })
        return void dialog(path.join(toolDir, message.name.replace(/_/g, '-'), 'tool.py'),
                           message.args ?? {}, devices, tools)
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
    assert.equal(device.stops, 1)
    outcomes[background ? 'background' : 'stepped'] = { result, device }
  }
  const [live, stepped] = [outcomes.background, outcomes.stepped]
  // The same goal costs the same device time on both...
  assert.ok(Math.abs(live.result.elapsed_s - stepped.result.elapsed_s) < 0.05,
    `device elapsed diverged: ${live.result.elapsed_s} vs ${stepped.result.elapsed_s}`)
  // ...reached in a single round where a background clock runs the motion, and
  // in many where the write is what advances it. That is the only difference.
  assert.equal(live.result.rounds, 1)
  assert.ok(stepped.result.rounds > 20, `expected many rounds, got ${stepped.result.rounds}`)
})

test('a round costs one round trip: the loop never reads', async () => {
  for (const background of [true, false]) {
    const device = arm({ background })
    const { result, error, stderr } = await move(device)
    assert.equal(error, undefined, stderr)
    // Exactly one read, the final verification; every other round trip is the
    // write that does the work and reports the state it produced.
    assert.equal(device.reads, 1, `background=${background}: ${device.reads} reads for ${result.rounds} rounds`)
    assert.equal(device.writes, result.rounds)
  }
})

test('timeout_s is a budget in the device clock, and on_timeout decides the exit', async () => {
  for (const background of [true, false]) {
    const held = arm({ background })
    const { result } = await move(held, { joints: [3.0, -3.0], timeout_s: 0.2 })
    assert.equal(result.terminated_by, 'timeout')
    assert.ok(Math.abs(result.elapsed_s - 0.2) < 1e-9, `elapsed ${result.elapsed_s}`)
    assert.equal(held.stops, 1, 'stop is the default exit')

    const running = arm({ background })
    const kept = await move(running, { joints: [3.0, -3.0], timeout_s: 0.2, on_timeout: 'continue' })
    assert.equal(kept.result.terminated_by, 'timeout')
    assert.equal(running.stops, 0, 'continue leaves the goal standing')
    assert.deepEqual(running.target, [3.0, -3.0])
  }
})

test('policy budget exhaustion never starts an extra action due to rounding', async () => {
  for (const background of [true, false]) {
    const device = arm({ background })
    const { result, stderr } = await dialog(tool('run-policy'), {
      model: 'policy', command: [{ device: 'arm' }], observation: {},
      action_hz: 10, timeout_s: 0.2, on_timeout: 'continue',
    }, { arm: device, policy: policy([{ actions: [[1, 1], [2, 2], [3, 3]], done: true }]) })
    assert.ok(result, stderr)
    assert.equal(result.terminated_by, 'timeout')
    assert.equal(result.actions_executed, 2)
    assert.ok(Math.abs(result.elapsed_s - 0.2) < 1e-9)
    assert.deepEqual(device.history.at(-1), [2, 2])
    assert.equal(device.stops, 0)
  }
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
  assert.equal(result.terminated_by, 'stalled')
  assert.equal(device.stops, 1)
})

test('the commanded device is stopped even when the loop raises', async () => {
  const device = arm({ background: false, refuse: true })
  const { result, stderr } = await move(device)
  assert.equal(result, undefined)
  assert.equal(device.stops, 1)
  assert.match(stderr, /must acknowledge accepted/)
  assert.doesNotMatch(stderr, /harness closed the dialog/)
})

test('track alternates perception and control, passing one to the other', async () => {
  const seen = []
  const controls = []
  const { result, error, stderr } = await dialog(
    tool('track'),
    { perceive: { tool: 'locate_object_3d', args: { prompt: 'mug' } },
      control: { tool: 'move_to', args: { device: 'arm', timeout_s: 0.3 } },
      timeout_s: 5 },
    { arm: arm({ background: true }) },
    {
      locate_object_3d: (a) => { seen.push(a); return { point: [0.4, 0, 0], frame: 'arm' } },
      move_to: (a) => {
        controls.push(a)
        // Converge after three rounds, as a real controller closing on a target would.
        return { reached: controls.length >= 3, elapsed_s: 0.3, terminated_by: 'timeout' }
      },
    },
  )
  assert.equal(error, undefined, stderr)
  assert.equal(result.terminated_by, 'reached')
  assert.equal(result.rounds, 3)
  assert.equal(seen.length, 3, 'perception runs once per round')
  assert.deepEqual(seen[0], { prompt: 'mug' })
  // The controller receives its own args PLUS the perception result.
  assert.equal(controls[0].device, 'arm')
  assert.deepEqual(controls[0].observation, { point: [0.4, 0, 0], frame: 'arm' })
  // Budget is summed from what the controller reported, in the device clock.
  assert.ok(Math.abs(result.elapsed_s - 0.9) < 1e-6, `elapsed ${result.elapsed_s}`)
})

test('the controller timeout alone spans open loop to closed loop', async () => {
  // One long round is open loop; many short rounds are closed loop. Same tool.
  for (const [segment, expected] of [[5, 1], [0.5, 10]]) {
    let rounds = 0
    const { result } = await dialog(
      tool('track'),
      { perceive: { tool: 'p' }, control: { tool: 'move_to', args: { device: 'arm', timeout_s: segment } },
        timeout_s: 5, stop_when_reached: false },
      { arm: arm({ background: true }) },
      { p: () => ({ point: [1, 0, 0], frame: 'arm' }),
        move_to: (a) => { rounds++; return { reached: false, elapsed_s: a.timeout_s, terminated_by: 'timeout' } } },
    )
    assert.equal(result.terminated_by, 'timeout')
    assert.equal(rounds, expected, `segment ${segment}s should give ${expected} rounds`)
  }
})

test('track retries a blind round and gives up after max_misses', async () => {
  let attempts = 0, commanded = 0
  const { result } = await dialog(
    tool('track'),
    { perceive: { tool: 'p' }, control: { tool: 'move_to', args: { device: 'arm', timeout_s: 1 } }, timeout_s: 5, max_misses: 3 },
    { arm: arm({ background: true }) },
    { p: () => { attempts++; return { point: null } }, move_to: () => { commanded++; return {} } },
  )
  assert.equal(result.terminated_by, 'perception_lost')
  assert.equal(attempts, 3)
  assert.equal(commanded, 0, 'never command on an observation that located nothing')
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
    assert.equal(device.stops, 1)
    outcomes[background ? 'background' : 'stepped'] = { result, device }
  }
  // Three actions at 10 Hz is 0.3 s of robot time whoever advances the clock...
  for (const key of ['background', 'stepped'])
    assert.ok(Math.abs(outcomes[key].result.elapsed_s - 0.3) < 1e-6, `${key}: ${outcomes[key].result.elapsed_s}`)
  // ...reached with one write per action where the command runs out, and five
  // where the write is the tick. The agent states neither number.
  assert.equal(outcomes.background.device.writes, 3)
  assert.equal(outcomes.stepped.device.writes, 15)
})

test('track rejects policy controllers before perception or inference', async () => {
  const model = policy([{ actions: [[0.2, 0.2]], done: true }])
  const { result, stderr } = await dialog(tool('track'), {
    perceive: { tool: 'observe' }, control: { tool: 'run_policy' }, timeout_s: 5,
  }, { policy: model })
  assert.equal(result, undefined)
  assert.match(stderr, /track supports only move_to/)
  assert.equal(model.calls, 0)
})

test('no builtin tool asks the agent to reason about the execution mode', async () => {
  const banned = /wall[- ]clock|simulation time|\brealtime\b|\bstepped\b/i
  for (const entry of await readdir(toolDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifest = await readFile(path.join(toolDir, entry.name, 'tool.yaml'), 'utf8')
    const offending = manifest.split('\n').filter((line) => banned.test(line))
    assert.deepEqual(offending, [], `${entry.name}/tool.yaml leaks the execution mode:\n${offending.join('\n')}`)
  }
})

test('nothing declares or reads device timing any more', async () => {
  // The device owns its timing entirely: a write runs the goal for the caller's
  // for_s and reports what it spent, so there is no execution block to read.
  const libDir = path.join(pythonLib, 'kinex')
  const readers = []
  for (const entry of await readdir(libDir)) {
    if (!entry.endsWith('.py')) continue
    const source = await readFile(path.join(libDir, entry), 'utf8')
    if (/\bexecution\b|command_timeout_s|interval_s/.test(source)) readers.push(entry)
  }
  assert.deepEqual(readers, [])
  for (const entry of await readdir(toolDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const source = await readFile(path.join(toolDir, entry.name, 'tool.py'), 'utf8')
    assert.doesNotMatch(source, /\bexecution\b/, `${entry.name}/tool.py reads the execution block`)
  }
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

test('continue applies only to timeout, never predicates, arrival, or stalled writes', async () => {
  for (const mode of ['predicate', 'reached', 'stalled']) {
    const device = arm({ background: true, stall: mode === 'stalled' })
    const { result, stderr } = await dialog(tool('move-to'), {
      device: 'arm', joints: GOAL, timeout_s: 1, on_timeout: 'continue',
      ...(mode === 'predicate' ? { until: { tool: 'contact', every_s: 0.1 } } : {}),
    }, { arm: device }, { contact: () => ({ done: device.clock >= 0.1 }) })
    assert.ok(result, stderr)
    assert.equal(result.terminated_by, mode === 'predicate' ? 'until:contact' : mode)
    assert.equal(device.stops, 1)
  }
})

test('move_to accepts an observation frame and verifies measured final velocity', async () => {
  const device = arm({ background: true, ik: GOAL })
  const prof = device.profile
  device.profile = () => { const p = prof(); p.intrinsics.frames.camera = [1, 2, 3, 0, 0, 0, 1]; return p }
  const original = device.read
  device.read = () => ({ ...original(), velocities: [5, 0] })
  const { result, stderr } = await move(device, {
    joints: undefined, observation: { point: [0.1, 0, 0] }, frame: 'arm:camera', orientation: [0, 0, 0, 1],
  })
  assert.ok(result, stderr)
  assert.deepEqual(device.ikArgs.pose, [1.1, 2, 3, 0, 0, 0, 1])
  assert.equal(result.terminated_by, 'disturbed')
  assert.equal(result.quiet_verified, true)
})

test('track runs actual move_to segments and clips the final budget', async () => {
  for (const background of [true, false]) {
    const device = arm({ background, ik: [3, -3] })
    const { result, stderr } = await dialog(tool('track'), {
      perceive: { tool: 'point' },
      control: { tool: 'move_to', args: { device: 'arm', timeout_s: 0.2, on_timeout: 'continue', orientation: [0, 0, 0, 1] } },
      timeout_s: 0.25,
    }, { arm: device }, { point: () => ({ point: [1, 0, 0], frame: 'arm' }) })
    assert.ok(result, stderr)
    assert.equal(result.terminated_by, 'timeout')
    assert.equal(result.rounds, 2)
    assert.ok(Math.abs(result.elapsed_s - 0.25) < 1e-9)
    assert.equal(device.stops, 1)
  }
})

test('track stops a continuing move on the first miss and on final exit', async () => {
  const device = arm({ background: true, ik: [3, -3] })
  let perceptions = 0
  const { result, stderr } = await dialog(tool('track'), {
    perceive: { tool: 'point' },
    control: { tool: 'move_to', args: { device: 'arm', timeout_s: 0.1, on_timeout: 'continue', orientation: [0, 0, 0, 1] } },
    timeout_s: 5, max_misses: 2,
  }, { arm: device }, { point: () => {
    perceptions++
    if (perceptions === 3) assert.ok(device.stops >= 1, 'must stop before retrying perception')
    return { point: perceptions === 1 ? [1, 0, 0] : null, frame: 'arm' }
  } })
  assert.ok(result, stderr)
  assert.equal(result.terminated_by, 'perception_lost')
  assert.equal(device.stops, 3)
})

test('policy faults on a secondary device stop the whole group before the next action', async () => {
  const first = arm({ background: true }), second = arm({ background: true })
  const write = second.write
  second.write = a => { const r = write(a); r.state.faults = [{ code: 'overload' }]; return r }
  const { result, stderr } = await dialog(tool('run-policy'), {
    model: 'policy', observation: {}, command: [{ device: 'arm' }, { device: 'hand' }],
    action_hz: 10, timeout_s: 2, on_timeout: 'continue',
  }, { arm: first, hand: second, policy: policy([{ actions: [[0.1, 0.1, 0.1, 0.1], [0.2, 0.2, 0.2, 0.2]], done: true }]) })
  assert.ok(result, stderr)
  assert.equal(result.terminated_by, 'fault')
  assert.deepEqual(result.faulted_devices, ['hand'])
  assert.equal(result.actions_executed, 1)
  assert.equal(first.stops, 1)
  assert.equal(second.stops, 1)
})

test('drive and track schemas reject removed modes before execution', async () => {
  const { parse } = await import('yaml')
  const { z } = await import('zod')
  const schema = async name => z.fromJSONSchema(parse(await readFile(path.join(toolDir, name, 'tool.yaml'), 'utf8')).parameters)
  const hold = await schema('drive')
  assert.ok(hold.safeParse({ device: 'base', mode: 'walk', duration_s: 1 }).success)
  for (const extra of [{ displacement: { x: 1 } }, { observation: {} }, { timeout_s: 1 }, { on_timeout: 'continue' }])
    assert.equal(hold.safeParse({ device: 'base', mode: 'walk', duration_s: 1, ...extra }).success, false)
  const tracking = await schema('track')
  const args = { perceive: { tool: 'p' }, control: { tool: 'move_to', args: { device: 'arm', timeout_s: 1 } }, timeout_s: 5 }
  assert.ok(tracking.safeParse(args).success)
  for (const changed of [{ ...args.control, tool: 'run_policy' }, { ...args.control, args: { ...args.control.args, joints: [0] } }])
    assert.equal(tracking.safeParse({ ...args, control: changed }).success, false)
})

test('shipped driver wrappers enforce budgets and preserve vendor execution results', async () => {
  const { execFileSync } = await import('node:child_process')
  execFileSync(python, [path.join(root, 'test/driver_contract.py')], {
    env: { ...process.env, PYTHONPATH: pythonLib }, encoding: 'utf8',
  })
})

test('track stops on success, round limit, outer predicate, and child failures', async () => {
  for (const reason of ['reached', 'max_rounds', 'until:done', 'fault', 'stalled', 'disturbed', 'error']) {
    const device = arm({ background: true, ik: GOAL })
    let checks = 0
    const { result, stderr } = await dialog(tool('track'), {
      perceive: { tool: 'point' }, control: { tool: 'move_to', args: { device: 'arm', timeout_s: 0.1 } },
      timeout_s: 1, max_rounds: 1,
      ...(reason === 'until:done' ? { until: { tool: 'done' } } : {}),
    }, { arm: device }, {
      point: () => reason === 'error' ? {} : { point: [1, 0, 0] },
      done: () => ({ done: ++checks === 2 }),
      move_to: () => ({ elapsed_s: 0.1, reached: reason === 'reached',
        terminated_by: ['fault', 'stalled', 'disturbed', 'reached'].includes(reason) ? reason : 'timeout' }),
    })
    if (reason === 'error') {
      assert.equal(result, undefined)
      assert.match(stderr, /must return a point/)
    } else {
      assert.ok(result, stderr)
      assert.equal(result.terminated_by, reason)
    }
    assert.equal(device.stops, 1, reason)
  }
})

test('final verification errors or faults revoke move and policy continuation', async () => {
  for (const controller of ['move-to', 'run-policy']) {
    for (const faults of [[{ code: 'fault' }], 'invalid']) {
      const device = arm({ background: true })
      const read = device.read
      device.read = () => ({ ...read(), faults })
      const { result, stderr } = controller === 'move-to'
        ? await move(device, { joints: [3, -3], timeout_s: 0.1, on_timeout: 'continue' })
        : await dialog(tool(controller), {
          model: 'policy', command: [{ device: 'arm' }], observation: {},
          timeout_s: 0.1, on_timeout: 'continue',
        }, { arm: device, policy: policy([{ actions: [[3, -3]] }]) })
      if (Array.isArray(faults)) assert.equal(result.terminated_by, 'fault')
      else { assert.equal(result, undefined); assert.match(stderr, /faults must be a list/) }
      assert.equal(device.stops, 1)
    }
  }
})

test('unmeasured final quietness is explicitly reported rather than invented', async () => {
  const device = arm({ background: true })
  const prof = device.profile, read = device.read
  device.profile = () => { const p = prof(); p.intrinsics.feedback.velocities = false; return p }
  device.read = () => ({ ...read(), velocities: [] })
  const { result, stderr } = await move(device)
  assert.ok(result, stderr)
  assert.equal(result.reached, true)
  assert.equal(result.quiet_verified, false)
})

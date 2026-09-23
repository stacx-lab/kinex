import { scoped } from "../scope.ts"
import { z } from "zod"
import { NamedError } from "../util/error.ts"
import { known, isJoint, isVelocity, deviceJoints, deviceHome, type Device } from "./profile/schema.ts"
import type { DeviceReading } from "./driver.ts"

// The virtual device — access.connection.kind "mock" — goes through the harness itself
// instead of an agent-written driver, on the same per-device code path as real
// hardware. Everything else (simulated embodiments included) is reached by its
// own driver.

// --- mock: deterministic in-memory device ----------------------------------
// Lets the whole harness run end-to-end with no hardware or simulator.

interface MockState {
  positions: number[]
  posture: Record<string, number>
  stopped: boolean
  clock: number
}

// The mock has no physics and no clock of the world's, so it keeps a synthetic
// one: an actuated mock advances it by a notional control period per write and
// arrives at once, while a sensor mock has nothing to advance and reads wall time.
const MOCK_INTERVAL_S = 0.02
const advancesOnWrite = (device: Device) => isJoint(device) || isVelocity(device) || device.type === "gripper" || device.type === "suction"

const sampleTime = (device: Device, state: MockState) =>
  advancesOnWrite(device) ? state.clock : performance.now() / 1000

// What a write reports back: the device pursued the goal and spent this much of
// its own clock doing it. The mock reaches instantly, so one interval, bounded
// by whatever budget the caller allowed.
function segment(state: MockState, args: Record<string, unknown>, read: () => DeviceReading) {
  const budget = z.number().positive().parse(args["for_s"])
  const spent = Math.min(MOCK_INTERVAL_S, budget)
  state.clock += spent
  return { accepted: true, elapsed_s: spent, reached: true, state: read().data }
}

const mocks = scoped(() => new Map<string, MockState>())

function mockState(workspace: string, device: Device): MockState {
  const key = `${workspace}/${device.name}`
  const existing = mocks().get(key)
  if (existing) return existing
  const joints = deviceJoints(device)
  const home = deviceHome(device)
  const created: MockState = {
    positions: home && home.length === joints.length ? [...home] : joints.map(() => 0),
    posture: isVelocity(device) && known(device.intrinsics.control)
      ? Object.fromEntries((Object.values(device.intrinsics.control.modes)[0]?.posture?.components ?? []).map((c) => [c.axis, c.default])) : {},
    stopped: false,
    clock: 0,
  }
  mocks().set(key, created)
  return created
}

function mockRead(workspace: string, device: Device): DeviceReading {
  const state = mockState(workspace, device)
  const frames = "frames" in device.intrinsics ? device.intrinsics.frames : {}
  const poses = Object.fromEntries(Object.keys(frames).filter((name) => frames[name] === null).map((name) => [name, [0, 0, 0, 0, 0, 0, 1]]))
  if (isVelocity(device) && known(device.intrinsics.feedback)) return {
    deviceID: device.name, kind: device.type,
    data: { pose: device.intrinsics.feedback.pose_frame === null ? null : { translation_m: [0, 0, state.posture.height ?? 0], rotation_xyzw: [0, 0, 0, 1] },
      velocities: known(device.intrinsics.feedback.velocity_components) ? device.intrinsics.feedback.velocity_components.map(() => 0) : [],
      frame_poses: poses,
      faults: [], sample_time_s: sampleTime(device, state), note: "synthetic stationary mock, no balance simulation" },
  }
  return {
    deviceID: device.name,
    kind: device.type,
    data: {
      note: "synthetic reading from the mock device",
      positions: [...state.positions],
      velocities: isJoint(device) && known(device.intrinsics.feedback) && !device.intrinsics.feedback.velocities ? [] : state.positions.map(() => 0),
      efforts: isJoint(device) && known(device.intrinsics.feedback) && device.intrinsics.feedback.efforts ? state.positions.map(() => 0) : [],
      frame_poses: poses,
      faults: [],
      stopped: state.stopped,
      sample_time_s: sampleTime(device, state),
    },
  }
}

export function mockAct(
  workspace: string,
  device: Device,
  action: string,
  args: Record<string, unknown>,
): DeviceReading {
  const state = mockState(workspace, device)
  if (action === "stop") {
    state.stopped = true
    return { deviceID: device.name, kind: device.type, data: { stopped: true } }
  }
  if (action === "read") return mockRead(workspace, device)
  if (action === "status") return { deviceID: device.name, kind: device.type, data: { loaded: device.loaded, mock: true } }
  if (action === "load" || action === "unload") return { deviceID: device.name, kind: device.type, data: { done: action } }
  if (isJoint(device) && action === "write") {
    const control = device.intrinsics.control
    if (!known(control)) throw new NamedError("DeviceCommandError", "joint control unresolved")
    const actions = z.array(z.array(z.number())).parse(args.actions)
    const period = 1 / z.number().positive().parse(args.freq_hz)
    const required = actions.length * period
    const elapsed = Math.min(required, args.for_s === undefined ? required : z.number().positive().parse(args.for_s))
    if (elapsed > 0) state.positions = [...actions[Math.min(Math.ceil(elapsed / period) - 1, actions.length - 1)]!]
    state.clock += elapsed
    const completed = Math.min(Math.floor(elapsed / period + 1e-8), actions.length)
    const reached = elapsed === required
    state.stopped = !reached || control.execution !== "realtime"
    return { deviceID: device.name, kind: device.type, data: { elapsed_s: elapsed,
      completed_actions: completed,
      terminated_by: !reached ? "timeout" : "completed",
      reference_state: state.stopped ? "stopped" : "target", execution_id: crypto.randomUUID(),
      state: mockRead(workspace, device).data } }
  }
  if (action === "write" && args.actions !== undefined && (device.type === "gripper" || device.type === "suction")) {
    const actions = z.array(z.array(z.number())).parse(args.actions)
    const period = 1 / z.number().positive().parse(args.freq_hz)
    const elapsed = Math.min(actions.length * period, args.for_s === undefined ? Infinity : z.number().positive().parse(args.for_s))
    const completed = Math.floor(elapsed / period + 1e-8)
    if (elapsed > 0) state.positions = [...actions[Math.min(Math.ceil(elapsed / period) - 1, actions.length - 1)]!]
    state.clock += elapsed
    state.stopped = true
    return { deviceID: device.name, kind: device.type, data: { elapsed_s: elapsed, completed_actions: completed,
      terminated_by: completed === actions.length ? "completed" : "timeout", state: mockRead(workspace, device).data } }
  }
  if (action === "write") {
    if (isVelocity(device)) {
      const target = args.posture === undefined ? {} : z.record(z.string(), z.number()).parse(args.posture)
      if (known(device.intrinsics.control)) state.posture = Object.fromEntries(
        (device.intrinsics.control.modes[z.string().parse(args.mode)]?.posture?.components ?? []).map((c) => [c.axis, target[c.axis] ?? c.default]),
      )
      state.stopped = false
      return { deviceID: device.name, kind: device.type,
        data: segment(state, args, () => mockRead(workspace, device)) }
    }
    const target = z.array(z.number()).parse(args["target"])
    const joints = deviceJoints(device)
    if (isJoint(device) && target.length !== joints.length)
      throw new NamedError("DeviceTargetError", "joint target dimension differs from joints")
    const limited = target.map((value, index) => {
      const limits = joints[index]?.limits
      if (!limits || !known(limits)) return value
      if (isJoint(device) && (value < limits.min || value > limits.max))
        throw new NamedError("DeviceTargetError", "target outside joint limits")
      return Math.min(Math.max(value, limits.min), limits.max)
    })
    state.positions = limited
    state.stopped = false
    return {
      deviceID: device.name,
      kind: device.type,
      data: { ...segment(state, args, () => mockRead(workspace, device)),
        moved: limited.map((value) => Number(value.toFixed(4))) },
    }
  }
  throw new NamedError("DeviceActionError", `unsupported mock device action "${action}"`)
}

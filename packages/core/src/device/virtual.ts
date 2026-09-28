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
  pending?: { actions: number[][]; start: number; duration: number }
}

const mocks = scoped(() => new Map<string, MockState>())
const clocks = scoped(() => new Map<string, number>())

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
    clock: clocks().get(workspace) ?? 0,
  }
  mocks().set(key, created)
  return created
}

function mockRead(workspace: string, device: Device): DeviceReading {
  const state = mockState(workspace, device)
  if (device.type === "world") return { deviceID: device.name, kind: device.type, data: { time_s: clocks().get(workspace) ?? 0 } }
  const frames = "frames" in device.intrinsics ? device.intrinsics.frames : {}
  const poses = Object.fromEntries(Object.keys(frames).filter((name) => frames[name] === null).map((name) => [name, [0, 0, 0, 0, 0, 0, 1]]))
  if (isVelocity(device) && known(device.intrinsics.feedback)) return {
    deviceID: device.name, kind: device.type,
    data: { pose: device.intrinsics.feedback.pose_frame === null ? null : { translation_m: [0, 0, state.posture.height ?? 0], rotation_xyzw: [0, 0, 0, 1] },
      velocities: known(device.intrinsics.feedback.velocity_components) ? device.intrinsics.feedback.velocity_components.map(() => 0) : [],
      frame_poses: poses,
      faults: [], sample_time_s: state.clock, note: "synthetic stationary mock, no balance simulation" },
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
      sample_time_s: state.clock,
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
    state.pending = undefined
    state.stopped = true
    return { deviceID: device.name, kind: device.type, data: { stopped: true } }
  }
  if (action === "read") return mockRead(workspace, device)
  if (action === "status") return { deviceID: device.name, kind: device.type, data: { loaded: device.loaded, mock: true } }
  if (action === "load" || action === "unload") return { deviceID: device.name, kind: device.type, data: { done: action } }
  if (device.type === "world" && action === "wait") {
    const duration = z.number().nonnegative().parse(args.duration_s)
    const time = (clocks().get(workspace) ?? 0) + duration
    clocks().set(workspace, time)
    for (const [key, peer] of mocks()) {
      if (!key.startsWith(`${workspace}/`)) continue
      peer.clock = time
      const pending = peer.pending
      if (!pending) continue
      const elapsed = time - pending.start
      const index = Math.min(Math.max(0, Math.ceil(elapsed * pending.actions.length / pending.duration) - 1), pending.actions.length - 1)
      if (elapsed > 0 && pending.actions[index]) peer.positions = [...pending.actions[index]!]
      if (elapsed >= pending.duration) peer.pending = undefined
    }
    return { deviceID: device.name, kind: device.type, data: { time_s: time, elapsed_s: duration } }
  }
  if (action === "write") {
    const duration = z.number().positive().parse(args.duration_s)
    const actions = isVelocity(device) ? [] : isJoint(device)
      ? z.array(z.array(z.number())).parse(args.actions) : z.array(z.number()).parse(args.actions).map(value => [value])
    if (isVelocity(device) && args.posture !== undefined)
      state.posture = z.record(z.string(), z.number()).parse(args.posture)
    state.pending = { actions, start: clocks().get(workspace) ?? 0, duration }
    state.stopped = false
    return { deviceID: device.name, kind: device.type, data: {
      execution_id: crypto.randomUUID(), elapsed_s: 0, state: mockRead(workspace, device).data,
    } }
  }
  throw new NamedError("DeviceActionError", `unsupported mock device action "${action}"`)
}

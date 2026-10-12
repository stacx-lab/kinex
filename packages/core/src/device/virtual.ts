import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { crc32, deflateSync } from "node:zlib"
import { shortID } from "../util/id.ts"
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

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const chunk = Buffer.concat([Buffer.from(type), data])
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(chunk))
  return Buffer.concat([length, chunk, checksum])
}

function mockCamera(workspace: string, device: Extract<Device, { type: "rgb" | "rgbd" }>, output: unknown, timestamp: number): DeviceReading {
  if (!known(device.intrinsics.color)) throw new NamedError("DeviceProfileError", "Mock camera needs color geometry")
  const { width, height } = device.intrinsics.color
  if (!known(width) || !known(height)) throw new NamedError("DeviceProfileError", "Mock camera needs known dimensions")
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const images: Record<string, Buffer> = { color: Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.alloc(height * (width * 3 + 1)))), pngChunk("IEND", Buffer.alloc(0)),
  ]) }
  if (device.type === "rgbd") {
    const depth = device.intrinsics.depth
    if (!known(depth) || !known(depth.width) || !known(depth.height)) throw new NamedError("DeviceProfileError", "Mock camera needs known depth dimensions")
    const pixels = Buffer.alloc(depth.width * depth.height * 2)
    for (let offset = 0; offset < pixels.length; offset += 2) pixels.writeUInt16BE(depth.invalid_value, offset)
    images.depth = Buffer.concat([Buffer.from(`P5\n${depth.width} ${depth.height}\n65535\n`), pixels])
  }
  const reading: DeviceReading = { deviceID: device.name, kind: device.type, data: { timestamp } }
  if (output !== "file") {
    reading.data = { timestamp, ...Object.fromEntries(Object.entries(images).map(([key, bytes]) => [key, bytes.toString("base64")])) }
    return reading
  }
  const directory = path.join(workspace, "devices", device.name, "out")
  mkdirSync(directory, { recursive: true })
  const id = shortID()
  for (const [key, bytes] of Object.entries(images)) {
    const file = path.join(directory, `${id}.${key === "color" ? "png" : "pgm"}`)
    writeFileSync(file, bytes)
    if (key === "color") reading.filePath = file
    else reading.data = { ...reading.data, depth_file: file }
  }
  return reading
}

function mockRead(workspace: string, device: Device): DeviceReading {
  const state = mockState(workspace, device)
  if (device.type === "world") return { deviceID: device.name, kind: device.type, data: { time_s: clocks().get(workspace) ?? 0 } }
  const frames = "frames" in device.intrinsics ? device.intrinsics.frames : {}
  const poses = Object.fromEntries(Object.keys(frames).filter((name) => frames[name]!.translation_m === null || frames[name]!.rotation_xyzw === null).map((name) => [name, [0, 0, 0, 0, 0, 0, 1]]))
  if (isVelocity(device) && known(device.intrinsics.feedback)) return {
    deviceID: device.name, kind: device.type,
    data: {
      velocities: known(device.intrinsics.feedback.velocity_components) ? device.intrinsics.feedback.velocity_components.map(() => 0) : [],
      ...(Object.keys(poses).length ? { frame_poses: poses } : {}),
      faults: [], timestamp: state.clock, note: "synthetic stationary mock, no balance simulation" },
  }
  if (device.type === "gripper") return {
    deviceID: device.name, kind: device.type,
    data: { aperture_m: known(device.intrinsics.feedback) && device.intrinsics.feedback.aperture_m ? 0 : null,
      faults: [], stopped: state.stopped, timestamp: state.clock },
  }
  return {
    deviceID: device.name,
    kind: device.type,
    data: {
      note: "synthetic reading from the mock device",
      positions: [...state.positions],
      velocities: isJoint(device) && known(device.intrinsics.feedback) && !device.intrinsics.feedback.velocities ? [] : state.positions.map(() => 0),
      efforts: isJoint(device) && known(device.intrinsics.feedback) && device.intrinsics.feedback.efforts ? state.positions.map(() => 0) : [],
      ...(!isJoint(device) ? { frame_poses: poses } : {}),
      faults: [],
      stopped: state.stopped,
      timestamp: state.clock,
    },
  }
}

export function mockAct(
  workspace: string,
  device: Device,
  action: string,
  args: Record<string, unknown>,
): DeviceReading {
  if (device.type === "legged_base" && ["read", "write"].includes(action))
    throw new NamedError("DeviceActionError", "legged SDK behavior requires a driver; the stationary mock does not simulate it")
  const state = mockState(workspace, device)
  if (action === "stop") {
    state.pending = undefined
    state.stopped = true
    return { deviceID: device.name, kind: device.type, data: { stopped: true } }
  }
  if (action === "read") return device.type === "rgb" || device.type === "rgbd"
    ? mockCamera(workspace, device, args.output, state.clock) : mockRead(workspace, device)
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
    return { deviceID: device.name, kind: device.type, data: { time_s: time, waited_s: duration } }
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
      execution_id: shortID(), state: mockRead(workspace, device).data,
    } }
  }
  throw new NamedError("DeviceActionError", `unsupported mock device action "${action}"`)
}

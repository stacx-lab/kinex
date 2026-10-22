import { deviceFrames, frameErrors } from "./frames.ts"
import { hasMissing } from "./common.ts"
import { commandedJoints, deviceTree, modelErrors } from "./urdf.ts"
import { cameraMissing } from "./camera.ts"
import { ProfileStore, type ProfileSnapshot, type NeededEntry } from "./store.ts"
import {
  known,
  deviceActions,
  renderWorkspaceBounds,
  type Device,
  type DeviceType,
  type RobotManifest,
} from "./schema.ts"

// Section completeness is independent of prerequisite readiness. Explicit
// requests override completeness until a validated clear; task-ready includes
// every applicable section of each loaded gating device. Planning is read-only.

export type ItemStatus = "done" | "needs-calibration" | "ready" | "blocked"

export interface PlanItem {
  id: string
  title: string
  dependsOn: string[]
  optional: boolean
  status: ItemStatus
  detail: string
  // Device identity also supports requirement selectors in custom skills.
  device?: { name: string; type: DeviceType }
}

export interface ReadinessPlan {
  robotID?: string
  platform?: "real" | "sim"
  items: PlanItem[]
  counts: Record<ItemStatus, number>
  next: PlanItem[]
  // The needs-calibration queue, in plan order.
  needed: PlanItem[]
}

interface PlanContext {
  robot?: RobotManifest
  devices: Device[]
  needed: NeededEntry[]
}

interface Check {
  done: boolean
  detail: string
}

interface Node {
  id: string
  title: string
  dependsOn: string[]
  optional?: boolean
  device?: { name: string; type: DeviceType }
  check(ctx: PlanContext): Check
}

// Loaded devices of these types gate task readiness; world geometry is optional.
const GATING_TYPES: readonly DeviceType[] = ["velocity", "legged_base", "joint", "gripper", "suction", "rgb", "rgbd"]

function factsCheck(device: Device): Check {
  switch (device.type) {
    case "legged_base": {
      if (hasMissing(Object.fromEntries(Object.entries(device).filter(([key]) => !["access", "frames", "runtime", "operations"].includes(key))))) return { done: false, detail: "legged control or stop is incomplete" }
      return { done: true, detail: "SDK-defined legged control" }
    }
    case "rgb":
    case "rgbd": {
      const color = device.color
      if (!known(color) || cameraMissing(color)) return { done: false, detail: "color is incomplete" }
      if (device.type === "rgb") return { done: true, detail: `color ${color.width}x${color.height} (${device.source})` }
      const depth = device.depth
      if (!known(depth) || cameraMissing(depth)) return { done: false, detail: "depth is incomplete" }
      return { done: true, detail: `color ${color.width}x${color.height}, depth ${depth.scale_m_per_unit} m/unit ${depth.registration} (${device.source})` }
    }
    case "joint": {
      if ([device.model, device.home, device.stop].some(hasMissing)) return { done: false, detail: "URDF model, home or stop is incomplete" }
      const tree = deviceTree(device)
      if (!tree) return { done: false, detail: modelErrors.get(device) ?? "joint URDF is unresolved" }
      const tip = known(device.model) ? device.model.tip_link : null
      return { done: true, detail: `${commandedJoints(tree).length} joints, ${device.limits} limits${tip ? `, tip ${tip}` : ""}` }
    }
    case "gripper": {
      if ([device.model, device.grip, device.stop].some(hasMissing)) return { done: false, detail: "URDF model, grip or stop is incomplete" }
      const tree = deviceTree(device)
      if (!tree) return { done: false, detail: modelErrors.get(device) ?? "gripper URDF is unresolved" }
      if (!device.frames.tcp) return { done: false, detail: "declare frames.tcp, the grasp point with +z approach" }
      return { done: true, detail: `${tree.links.length} URDF links, grip ${known(device.grip) ? device.grip.joint : ""}` }
    }
    case "suction": {
      if ([device.vacuum, device.stop].some(hasMissing)) return { done: false, detail: "vacuum or stop is incomplete" }
      if (!device.frames.tcp) return { done: false, detail: "declare frames.tcp, the cup contact centre with +z approach" }
      return { done: true, detail: `${device.vacuum} suction` }
    }
    case "velocity": {
      if (hasMissing(Object.fromEntries(Object.entries(device).filter(([key]) => !["access", "frames", "runtime", "operations"].includes(key))))) return { done: false, detail: "velocity control, feedback or stop is incomplete" }
      return { done: true, detail: `velocity controller, ${deviceActions(device).length} command dimensions` }
    }
    case "imu": {
      const measurement = device.measurement
      if (!known(measurement) || hasMissing(measurement)) return { done: false, detail: "IMU measurement is incomplete" }
      const acceleration = measurement.linear_acceleration
      return { done: true, detail: `IMU channels: ${Object.entries(measurement).filter(([, value]) => value !== null).map(([key]) => key).join(", ")}${acceleration && known(acceleration) ? `; ${acceleration.quantity}` : ""}` }
    }
    case "force_torque": {
      if (hasMissing(Object.fromEntries(Object.entries(device).filter(([key]) => !["access", "frames", "runtime", "operations"].includes(key))))) return { done: false, detail: "force/torque measurement is incomplete" }
      const measurement = device.measurement
      if (!known(measurement)) return { done: false, detail: "measurement is ???" }
      return { done: true, detail: `${measurement.quantity}; force: ${measurement.force && known(measurement.force) ? measurement.force.axes.join(",") : "none"}; torque: ${measurement.torque && known(measurement.torque) ? measurement.torque.axes.join(",") : "none"}` }
    }
    case "world": {
      const bounds = device.bounds
      if (!known(bounds)) return { done: false, detail: "bounds is ???" }
      const surfaces = device.surfaces
      if (surfaces.some((surface) => !known(surface.pose) || !known(surface.extent)))
        return { done: false, detail: "surface geometry is incomplete (optional)" }
      const surfaceBit = surfaces.length > 0 ? `; surfaces: ${surfaces.map((surface) => surface.name).join(", ")}` : ""
      return { done: true, detail: `${bounds === null ? "no bounds declared" : `${renderWorkspaceBounds(bounds)} m`}${surfaceBit}` }
    }
    case "model": {
      const { family, artifacts, compute } = device
      if (!known(family)) return { done: false, detail: "family is ???" }
      if (!known(artifacts)) return { done: false, detail: "artifacts is ???" }
      if (!known(compute)) return { done: false, detail: "compute is ???" }
      if (Object.keys(device.operations).length === 0)
        return { done: false, detail: `${family} declared but no operations — expose its inference services` }
      const placement = compute.kind === "cuda" ? `cuda:${compute.index}` : compute.kind
      return {
        done: true,
        detail: `${family}${device.variant ? ` (${device.variant})` : ""} on ${placement}: ${Object.keys(device.operations).join(", ")}`,
      }
    }
    default:
      return { done: true, detail: "no intrinsic model required" }
  }
}

function profileCheck(device: Device, devices: Device[]): Check {
  const facts = factsCheck(device)
  if (!facts.done || device.type === "model") return facts
  const errors = frameErrors(devices).filter(message => message.startsWith(`${device.name}:`))
  if (errors.length) return { done: false, detail: errors.join("; ") }
  for (const [name, frame] of Object.entries(deviceFrames(device))) {
    if (frame.parent === null) continue
    if (frame.translation_m === null || frame.rotation_xyzw === null)
      return { done: false, detail: `frames.${name} transform is unknown; calibrate or supply measured TF` }
  }
  return facts
}

function accessCheck(device: Device): Check {
  if (device.runtime) return { done: true, detail: `${Object.keys(device.operations).length} declared ROS operations; load checks live readiness` }
  return { done: false, detail: "configure runtime.nodes and operations; legacy drivers and in-memory mocks are unsupported" }
}

function deviceNodes(device: Device): Node[] {
  const ref = { name: device.name, type: device.type }
  // Unloaded devices are off-limits to the tools, so nothing about them can
  // hold the robot back: their whole chain is optional.
  const optional = !GATING_TYPES.includes(device.type) || !device.loaded
  return [{
    id: `access:${device.name}`, title: `Access (${device.name})`,
    dependsOn: ["devices-declared"], optional: device.type === "world" ? !device.loaded : optional,
    device: ref, check: () => accessCheck(device),
  }, {
    id: `profile:${device.name}`, title: `Profile (${device.name})`,
    dependsOn: [`access:${device.name}`], optional, device: ref,
    check: ctx => profileCheck(device, ctx.devices),
  }]
}

function buildNodes(ctx: PlanContext): Node[] {
  const robot = ctx.robot
  const nodes: Node[] = [
    {
      id: "identity",
      title: "Robot identity & platform",
      dependsOn: [],
      check: () => {
        if (!robot) return { done: false, detail: "no robot manifest" }
        const identity = robot.identity
        return {
          done: true,
          detail: `${identity.id}: ${identity.kind} ${known(identity.model) ? `(${identity.model})` : ""}`,
        }
      },
    },

    {
      id: "devices-declared",
      title: "Device inventory",
      dependsOn: ["identity"],
      check: () => {
        if (!ctx.devices.length) return { done: false, detail: "no devices recorded — declare its control and observation endpoints" }
        if (!ctx.devices.some((device) => device.type === "world"))
          return { done: false, detail: "no world device — every workspace requires one for its clock" }
        return { done: true, detail: ctx.devices.map((device) => `${device.name} (${device.type})`).join(", ") }
      },
    },
  ]
  for (const device of [...ctx.devices].sort((a, b) => a.name.localeCompare(b.name)))
    nodes.push(...deviceNodes(device))

  // Completed geometry can coexist with unavailable access, so include every
  // applicable section explicitly. Unloaded devices do not hold up readiness.
  const gatingItems = ctx.devices
    .filter((device) => GATING_TYPES.includes(device.type) && device.loaded)
    .flatMap((device) =>
      nodes.filter((node) => node.device?.name === device.name).map((node) => node.id),
    )
    .sort()

  nodes.push(
    {
      id: "safety",
      title: "Safety limits",
      dependsOn: ["identity"],
      check: () => {
        const safety = robot?.safety
        const cart = safety && known(safety.max_cartesian_velocity) ? safety.max_cartesian_velocity : undefined
        const joint = safety && known(safety.max_joint_velocity) ? safety.max_joint_velocity : undefined
        return cart !== undefined || joint !== undefined
          ? { done: true, detail: `cart: ${cart === null ? "no additional cap" : cart === undefined ? "???" : `<=${cart} m/s`}, joint: ${joint === null ? "no additional cap" : joint === undefined ? "???" : `<=${joint} rad/s`}` }
          : { done: false, detail: "safety velocity limits are ???" }
      },
    },
    {
      id: "task-ready",
      title: "Profile completeness",
      dependsOn: ["identity", "devices-declared", "safety", ...gatingItems],
      check: () => ({ done: false, detail: "" }), // overridden: done iff all deps done
    },
  )
  return nodes
}

// Kahn topological sort; the static graph is authored in order, but per-device
// nodes are appended and future edits must not silently introduce cycles.
function topoSort(nodes: Node[]): Node[] {
  const byID = new Map(nodes.map((node) => [node.id, node]))
  const indegree = new Map(nodes.map((node) => [node.id, 0]))
  for (const node of nodes)
    for (const dep of node.dependsOn) if (byID.has(dep)) indegree.set(node.id, (indegree.get(node.id) ?? 0) + 1)
  const queue = nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id)
  const order: Node[] = []
  while (queue.length > 0) {
    const id = queue.shift()!
    order.push(byID.get(id)!)
    for (const node of nodes)
      if (node.dependsOn.includes(id)) {
        const remaining = (indegree.get(node.id) ?? 0) - 1
        indegree.set(node.id, remaining)
        if (remaining === 0) queue.push(node.id)
      }
  }
  if (order.length !== nodes.length) throw new Error("calibration DAG has a cycle")
  return order
}

function planContext(snapshot: ProfileSnapshot): PlanContext {
  return { ...snapshot, needed: ProfileStore.needed(snapshot) }
}

// Raw completeness check used before an explicit marker clear is committed.
export async function checkReadinessItem(cwd: string, snapshot: ProfileSnapshot, item: string): Promise<Check> {
  const ctx = planContext(snapshot)
  const node = buildNodes(ctx).find((node) => node.id === item && node.id !== "task-ready")
  if (!node) throw new Error(`unknown calibration item "${item}"`)
  return node.check(ctx)
}

export async function readinessPlan(cwd: string, snapshot?: ProfileSnapshot): Promise<ReadinessPlan> {
  const ctx = planContext(snapshot ?? await ProfileStore.snapshot(cwd))
  const robot = ctx.robot
  const robotID = robot?.identity.id
  const neededByItem = new Map(ctx.needed.map((entry) => [entry.item, entry]))

  const ordered = topoSort(buildNodes(ctx))
  const statuses = new Map<string, ItemStatus>()
  const items: PlanItem[] = []
  for (const node of ordered) {
    const unmet = node.dependsOn.filter((dep) => statuses.get(dep) !== "done")
    const { done, detail } = node.id === "task-ready" ? {
      done: unmet.length === 0,
      detail: unmet.length === 0 ? "all prerequisites satisfied" : `waiting on ${unmet.length} items: ${unmet.slice(0, 4).join(", ")}${unmet.length > 4 ? ", …" : ""}`,
    } : node.check(ctx)
    const marker = neededByItem.get(node.id)
    const status: ItemStatus = marker ? "needs-calibration" : done ? "done" : unmet.length ? "blocked" : "ready"
    statuses.set(node.id, status)
    items.push({
      id: node.id,
      title: node.title,
      dependsOn: node.dependsOn,
      optional: node.optional ?? false,
      status,
      detail: status === "needs-calibration" && marker?.note ? `${detail} — ${marker.note}` : detail,
      ...(node.device ? { device: node.device } : {}),
    })
  }

  const counts: Record<ItemStatus, number> = { done: 0, "needs-calibration": 0, ready: 0, blocked: 0 }
  for (const item of items) counts[item.status] += 1
  const next = items.filter((item) => item.status === "ready" && !item.optional)
  const needed = items.filter((item) => item.status === "needs-calibration")
  return { robotID, items, counts, next, needed }
}

export function itemSelector(item: PlanItem): string | undefined {
  if (!item.device) return undefined
  const colon = item.id.indexOf(":")
  return `${item.id.slice(0, colon)}:${item.device.type}`
}

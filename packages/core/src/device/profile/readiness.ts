import { hasMissing } from "./common.ts"
import { jointModel, jointModelErrors } from "./joint.ts"
import { cameraMissing } from "./camera.ts"
import { ProfileStore, type ProfileSnapshot, type NeededEntry } from "./store.ts"
import { driverExists } from "../driver.ts"
import { missingActions, requiredActions } from "../interface.ts"
import {
  deviceMount,
  devicePoseFeedback,
  known,
  deviceActions,
  isModel,
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
  // Device names whose access.driver file exists on disk. Precomputed so the
  // node checks stay synchronous.
  drivers: Set<string>
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
const GATING_TYPES: readonly DeviceType[] = ["velocity", "joint", "dexterous_hand", "gripper", "suction", "rgb", "rgbd"]

function intrinsicsCheck(device: Device): Check {
  if ("frames" in device.intrinsics) {
    const contacts = new Set(device.type === "gripper" ? Object.values(device.intrinsics.geometry?.contacts ?? {}).map((c) => c.frame) : [])
    if (Object.entries(device.intrinsics.frames).some(([name, pose]) => hasMissing(pose) && !contacts.has(name)))
      return { done: false, detail: "intrinsics.frames contains uncalibrated transforms" }
  }
  switch (device.type) {
    case "rgb":
    case "rgbd": {
      const color = device.intrinsics.color
      if (!known(color) || cameraMissing(color)) return { done: false, detail: "intrinsics.color is incomplete" }
      if (device.type === "rgb") return { done: true, detail: `color ${color.width}x${color.height} (${device.intrinsics.source})` }
      const depth = device.intrinsics.depth
      if (!known(depth) || cameraMissing(depth)) return { done: false, detail: "intrinsics.depth is incomplete" }
      return { done: true, detail: `color ${color.width}x${color.height}, depth ${depth.scale_m_per_unit} m/unit ${depth.registration} (${device.intrinsics.source})` }
    }
    case "dexterous_hand":
    case "joint": {
      if (hasMissing(device.intrinsics)) return { done: false, detail: "joint model, home, control, feedback or stop is incomplete" }
      const model = jointModel(device.intrinsics)
      if (!model) return { done: false, detail: jointModelErrors.get(device.intrinsics) ?? "joint model is unresolved" }
      return { done: true, detail: `${model.joints.length} joints, model resolved` }
    }
    case "suction":
    case "gripper": {
      const type = device.type
      if ([device.intrinsics.control, device.intrinsics.feedback, device.intrinsics.stop].some(hasMissing)) return { done: false, detail: "end-effector control, feedback or stop semantics are incomplete" }
      return { done: true, detail: `${type}, ${deviceActions(device).length} command dimensions` }
    }
    case "velocity": {
      if (hasMissing(device.intrinsics)) return { done: false, detail: "velocity control, feedback or stop is incomplete" }
      return { done: true, detail: `velocity controller, ${deviceActions(device).length} command dimensions` }
    }
    case "imu": {
      const measurement = device.intrinsics.measurement
      if (!known(measurement) || hasMissing(measurement)) return { done: false, detail: "IMU measurement is incomplete" }
      const acceleration = measurement.linear_acceleration
      return { done: true, detail: `IMU channels: ${Object.entries(measurement).filter(([, value]) => value !== null).map(([key]) => key).join(", ")}${acceleration && known(acceleration) ? `; ${acceleration.quantity}` : ""}` }
    }
    case "force_torque": {
      if (hasMissing(device.intrinsics)) return { done: false, detail: "force/torque measurement is incomplete" }
      const measurement = device.intrinsics.measurement
      if (!known(measurement)) return { done: false, detail: "measurement is ???" }
      return { done: true, detail: `${measurement.quantity}; force: ${measurement.force && known(measurement.force) ? measurement.force.axes.join(",") : "none"}; torque: ${measurement.torque && known(measurement.torque) ? measurement.torque.axes.join(",") : "none"}` }
    }
    case "world": {
      const bounds = device.intrinsics.bounds
      if (!known(bounds)) return { done: false, detail: "intrinsics.bounds is ???" }
      const surfaces = device.intrinsics.surfaces
      if (surfaces.some((surface) => !known(surface.pose) || !known(surface.extent)))
        return { done: false, detail: "surface geometry is incomplete (optional)" }
      const surfaceBit = surfaces.length > 0 ? `; surfaces: ${surfaces.map((surface) => surface.name).join(", ")}` : ""
      return { done: true, detail: `${bounds === null ? "no bounds declared" : `${renderWorkspaceBounds(bounds)} m`}${surfaceBit}` }
    }
    case "detection":
    case "segmentation":
    case "model": {
      const family = device.intrinsics.family
      if (!known(family)) return { done: false, detail: "intrinsics.family is ???" }
      if (!known(device.intrinsics.artifacts)) return { done: false, detail: "intrinsics.artifacts is ???" }
      if (device.intrinsics.operations.length === 0)
        return { done: false, detail: `${family} declared but no operations — record the inference input/output contracts` }
      return {
        done: true,
        detail: `${family}${device.intrinsics.variant ? ` (${device.intrinsics.variant})` : ""}: ${device.intrinsics.operations.map((operation) => operation.name).join(", ")}`,
      }
    }
    default:
      return { done: true, detail: "no intrinsic model required" }
  }
}

function extrinsicsCheck(device: Device): Check {
  // Narrowing only — deviceNodes never emits extrinsics nodes for world/model.
  if (device.type === "world") return { done: true, detail: "world is an optional reference frame" }
  if (isModel(device)) return { done: true, detail: "a model has no physical pose" }
  if (device.type === "rgbd" && known(device.intrinsics.depth) && device.intrinsics.depth.registration === "native"
    && cameraMissing(device.extrinsics.depth_to_color))
    return { done: false, detail: "extrinsics.depth_to_color is incomplete" }
  const mount = deviceMount(device)
  if ((device.type === "force_torque" || device.type === "imu") && hasMissing(device.extrinsics))
    return { done: false, detail: "measurement frame is incomplete" }
  const feedback = devicePoseFeedback(device)
  if (feedback !== undefined) {
    if (!known(feedback) || !known(feedback.pose_frame)) return { done: false, detail: "feedback.pose_frame is ???" }
    return { done: true, detail: feedback.pose_frame === null ? "unlocalized device root" : `runtime pose in ${feedback.pose_frame}` }
  }
  if (mount === undefined || !known(mount)) return { done: false, detail: "extrinsics.mount is ???" }
  if (!known(mount.translation_m) || hasMissing(mount)) return { done: false, detail: "extrinsics.mount is incomplete" }
  const at = mount.translation_m.map((n) => n.toFixed(3)).join(", ")
  return { done: true, detail: `on ${mount.parent}${mount.parent_frame ? ` (${mount.parent_frame})` : ""} at (${at}) m` }
}

function accessCheck(device: Device, ctx: PlanContext): Check {
  const access = device.access
  if (!access || !known(access.connection) || hasMissing(access.connection))
    return { done: false, detail: "access.connection is incomplete" }
  const kind = access.connection.kind
  if (kind === "mock" && !access.driver) return { done: true, detail: "mock (in-memory synthetic device)" }
  if (!access.driver) return { done: false, detail: `${kind}: no access.driver` }
  if (!ctx.drivers.has(device.name))
    return { done: false, detail: `${kind}, access.driver is ${access.driver.entry} but that file does not exist` }
  const missing = missingActions(device, access.driver.actions)
  if (missing.length > 0)
    return {
      done: false,
      detail: `${kind} via ${access.driver.entry}, but the driver is missing ${missing.map((action) => `"${action}"`).join(", ")} — the ${device.type} driver interface requires ${requiredActions(device).join("/")}`,
    }
  return {
    done: true,
    detail: `${kind} via ${access.driver.entry}`,
  }
}

function deviceNodes(device: Device): Node[] {
  const ref = { name: device.name, type: device.type }
  // Unloaded devices are off-limits to the tools, so nothing about them can
  // hold the robot back: their whole chain is optional.
  const optional = !GATING_TYPES.includes(device.type) || !device.loaded
  // World geometry is optional; clock access is checked independently.
  if (device.type === "world")
    return [
      {
        id: `access:${device.name}`, title: `Clock access (${device.name})`,
        dependsOn: ["devices-declared"], optional: !device.loaded, device: ref,
        check: (ctx) => accessCheck(device, ctx),
      },
      {
        id: `intrinsics:${device.name}`,
        title: `Spatial information (${device.name})`,
        dependsOn: ["devices-declared"],
        optional,
        device: ref,
        check: () => intrinsicsCheck(device),
      },
    ]
  const nodes: Node[] = [{
    id: `access:${device.name}`,
    title: `Access (${device.name})`,
    dependsOn: ["devices-declared"],
    optional,
    device: ref,
    check: (ctx) => accessCheck(device, ctx),
  }]
  nodes.push({
    id: `intrinsics:${device.name}`,
    title: `Intrinsics (${device.name})`,
    dependsOn: [`access:${device.name}`],
    optional,
    device: ref,
    check: () => intrinsicsCheck(device),
  })
  // A model has no physical pose — its chain ends at intrinsics.
  if (isModel(device)) return nodes
  nodes.push({
    id: `extrinsics:${device.name}`,
    title: `Extrinsics (${device.name})`,
    dependsOn: [`intrinsics:${device.name}`],
    optional,
    device: ref,
    check: () => extrinsicsCheck(device),
  })
  return nodes
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
          detail: `${identity.id}: ${identity.kind} (${identity.platform}${known(identity.model) ? `, ${identity.model}` : ""})`,
        }
      },
    },

    {
      id: "devices-declared",
      title: "Device inventory",
      dependsOn: ["identity"],
      check: () =>
        ctx.devices.length > 0
          ? { done: true, detail: ctx.devices.map((device) => `${device.name} (${device.type})`).join(", ") }
          : { done: false, detail: "no devices recorded — declare its control and observation endpoints" },
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
      title: "Task-ready",
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

async function planContext(cwd: string, snapshot: ProfileSnapshot): Promise<PlanContext> {
  const drivers = await Promise.all(snapshot.devices.map(async (device) => await driverExists(cwd, device) ? device.name : undefined))
  return { ...snapshot, needed: ProfileStore.needed(snapshot), drivers: new Set(drivers.filter((name) => name !== undefined)) }
}

// Raw completeness check used before an explicit marker clear is committed.
export async function checkReadinessItem(cwd: string, snapshot: ProfileSnapshot, item: string): Promise<Check> {
  const ctx = await planContext(cwd, snapshot)
  const node = buildNodes(ctx).find((node) => node.id === item && node.id !== "task-ready")
  if (!node) throw new Error(`unknown calibration item "${item}"`)
  return node.check(ctx)
}

export async function readinessPlan(cwd: string, snapshot?: ProfileSnapshot): Promise<ReadinessPlan> {
  const ctx = await planContext(cwd, snapshot ?? await ProfileStore.snapshot(cwd))
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
  return { robotID, platform: robot?.identity.platform, items, counts, next, needed }
}

export function itemSelector(item: PlanItem): string | undefined {
  if (!item.device) return undefined
  const colon = item.id.indexOf(":")
  return `${item.id.slice(0, colon)}:${item.device.type}`
}

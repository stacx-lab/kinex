import { deviceFrames } from "../device/profile/frames.ts"
import { cameraMissing } from "../device/profile/camera.ts"
import { ProfileStore, type ProfileSnapshot } from "../device/profile/store.ts"
import { readinessPlan, type ReadinessPlan } from "../device/profile/readiness.ts"
import { isModel, devicePoseFeedback, deviceMount, known, deviceJoints, deviceActions, renderWorkspaceBounds, type Device } from "../device/profile/schema.ts"

// "arm:link7" — the parent and, when named, the frame the pose is expressed in.
function mountFrame(mount: { parent: string; parent_frame?: string }): string {
  return mount.parent_frame && mount.parent_frame !== mount.parent ? `${mount.parent}:${mount.parent_frame}` : mount.parent
}

function accessBit(device: Device): string {
  const access = device.access
  if (!access) return ""
  const connection = access.connection
  const driver = access.driver ? `, driver ${access.driver.entry}` : ""
  return known(connection) ? `, ${connection.kind}${driver}` : driver
}

function deviceLine(device: Device): string {
  // Unloaded devices stay listed — the model must know they exist and that the
  // user can bring them back with /load (spelled out once, below the list).
  const bits: string[] = [
    `${device.name} (${device.type}${accessBit(device)})${device.loaded ? "" : " [UNLOADED]"}`,
  ]
  switch (device.type) {
    case "legged_base": {
      const { control } = device.intrinsics
      if (known(control)) {
        if (control.device_modes) bits.push(`, device states: ${Object.keys(control.device_modes).join(", ")}`)
        if (Object.keys(control.skills).length) bits.push(`, SDK skills: ${Object.keys(control.skills).join(", ")}`)
      }
      bits.push(", profile-defined read/write; prefer shared velocity conventions; unlocalized root")
      break
    }
    case "rgb":
    case "rgbd": {
      bits.push(!cameraMissing(device.intrinsics.color) ? ` intrinsics: known (${device.intrinsics.source})` : " intrinsics: ???")
      if (device.type === "rgbd") {
        const depth = device.intrinsics.depth
        bits.push(known(depth) ? ` depth: ${depth.scale_m_per_unit} m/unit ${depth.registration}` : " depth: ???")
      }
      const mount = deviceMount(device)
      bits.push(mount !== undefined && known(mount) ? ` mounted on ${mountFrame(mount)}${mount.dynamic ? " (dynamic)" : ""}` : " extrinsics: ???")
      bits.push(
        device.type === "rgbd"
          ? "; read returns file (RGB PNG) and depth_file (16-bit PGM); inspect RGB with the host file-reading tool"
          : "; read returns file (RGB PNG); inspect it with the host file-reading tool",
      )
      break
    }
    case "dexterous_hand":
    case "joint": {
      bits.push(device.type === "joint" ? " absolute joint targets; arrival: closed_loop + settled" : " finger joint targets")
      const joints = deviceJoints(device)
      bits.push(joints.length ? ` ${joints.length} dof; model resolved` : " model: ???")
      if (device.type === "dexterous_hand") {
        const geometry = device.intrinsics.geometry
        if (geometry?.description) bits.push(`; ${geometry.description}`)
        if (!geometry?.fingers) bits.push("; fingertip geometry unavailable")
        if (geometry?.fingers) bits.push(`; local fingertip prediction: ${Object.values(geometry.fingers).map((finger) => `${device.name}:${finger.tip_frame}`).join(", ")}`)
        if (geometry?.center) bits.push(`; predicted center ${device.name}:${geometry.center.frame}`)
      }
      break
    }
    case "suction":
    case "gripper": {
      const { control, stop } = device.intrinsics
      if (known(control)) bits.push(`, control ${control.mode}`)
      if (known(stop)) bits.push(`, stop ${stop.behavior} [${stop.affected_devices.join(", ")}]`)
      if (device.type === "gripper") {
        const { geometry, aperture_m } = device.intrinsics
        if (aperture_m) bits.push(`, opening ${aperture_m.min}–${aperture_m.max} m`)
        if (!geometry) bits.push(", geometry unknown; do not infer jaw axes from the mount")
        if (geometry) bits.push(`, approach ${JSON.stringify(geometry.approach_axis)}, fixed closing axis ${JSON.stringify(geometry.closing_axis)}${geometry.description ? `; ${geometry.description}` : ""}`)
      }
      break
    }
    case "velocity": {
      const { control, stop } = device.intrinsics
      if (known(control)) bits.push(`, motion modes: ${Object.keys(control.modes).join(", ")}`)
      if (known(stop)) bits.push(`, stop ${stop.behavior}`)
      bits.push(", unlocalized root")
      break
    }
    case "detection":
    case "segmentation":
    case "model": {
      const family = device.intrinsics.family
      if (known(family)) {
        bits.push(` ${family}${device.intrinsics.variant ? ` (${device.intrinsics.variant})` : ""}`)
        if (device.intrinsics.operations.length > 0)
          bits.push(`: ${device.intrinsics.operations.map((operation) => operation.name).join(", ")} (via the device tool)`)
      } else bits.push(" family: ???")
      break
    }
    case "imu": {
      const measurement = device.intrinsics.measurement
      if (!known(measurement)) { bits.push(" measurement: ???"); break }
      for (const key of ["angular_velocity", "linear_acceleration", "magnetic_field"] as const) {
        const channel = measurement[key]
        bits.push(`; ${key}: ${channel === null ? "unsupported" : known(channel) ? channel.axes.join(",") : "???"}`)
      }
      const acceleration = measurement.linear_acceleration
      if (acceleration && known(acceleration)) bits.push(` (${acceleration.quantity})`)
      const orientation = measurement.orientation
      bits.push(`; orientation: ${orientation === null ? "unsupported" : known(orientation) && known(orientation.reference) ? orientation.reference.kind : "???"}`)
      break
    }
    case "force_torque": {
      const measurement = device.intrinsics.measurement
      if (!known(measurement)) { bits.push(" measurement: ???"); break }
      bits.push(` ${measurement.quantity}`)
      for (const key of ["force", "torque"] as const) {
        const channel = measurement[key]
        bits.push(`; ${key}: ${channel === null ? "unsupported" : known(channel) ? channel.axes.join(",") : "???"}`)
      }
      if (known(measurement.target)) bits.push(` on ${measurement.target.device}:${measurement.target.frame}`)
      break
    }
    case "world": {
      const bounds = device.intrinsics.bounds
      bits.push(bounds === null ? " no bounds declared" : known(bounds) ? ` workspace ${renderWorkspaceBounds(bounds)} m (informational)` : " bounds: ???")
      for (const surface of device.intrinsics.surfaces) bits.push(`; ${surface.name} surface (${known(surface.extent) ? surface.extent.shape : "extent unknown"})`)
      break
    }
    default:
      break
  }
  return "    " + bits.join("")
}

// Mounts use explicit device frames; moving frames resolve from observations.
function mountTreeLines(devices: Device[]): string[] {
  const byName = new Map(devices.map((device) => [device.name, device]))
  const children = new Map<string, { name: string; note: string }[]>()
  const unplaced: string[] = []
  for (const device of devices) {
    if (device.type === "world" || isModel(device)) continue
    const mount = deviceMount(device)
    if (mount === undefined || !known(mount)) {
      const feedback = devicePoseFeedback(device)
      if (device.type === "velocity" || device.type === "legged_base" || (feedback !== undefined && known(feedback) && feedback.pose_frame === null)) continue
      unplaced.push(device.name)
      continue
    }
    const parent = byName.get(mount.parent)
    const frames = parent ? deviceFrames(parent) : {}
    const onNamedFrame = Object.hasOwn(frames, mount.parent_frame ?? "")
    const notes: string[] = []
    if (onNamedFrame) notes.push(`on ${mount.parent_frame}`)
    else if (mount.parent_frame && mount.parent_frame !== mount.parent) notes.push(`on ${mount.parent_frame}`)
    if (mount.dynamic) notes.push("dynamic")
    else if (!known(mount.translation_m) || !known(mount.rotation_xyzw)) notes.push("pose ???")
    const list = children.get(mount.parent) ?? []
    list.push({ name: device.name, note: notes.length > 0 ? ` (${notes.join(", ")})` : "" })
    children.set(mount.parent, list)
  }
  if (children.size === 0 && unplaced.length === 0) return []
  const lines = ["  frame tree (mounts and measured roots; named frames belong to intrinsics, see relative_pose):"]
  const visited = new Set<string>()
  const render = (parent: string, depth: number) => {
    for (const child of children.get(parent) ?? []) {
      if (visited.has(child.name)) continue
      visited.add(child.name)
      lines.push(`    ${"  ".repeat(depth)}${child.name}${child.note}`)
      render(child.name, depth + 1)
    }
  }
  lines.push("    world")
  render("world", 1)
  for (const root of [...children.keys()].sort()) {
    if (root === "world" || visited.has(root)) continue
    lines.push(`    ${root} (itself not placed)`)
    render(root, 1)
  }
  if (unplaced.length > 0) lines.push(`    unplaced (extrinsics ???): ${unplaced.sort().join(", ")}`)
  return lines
}

// Each actuated device's OWN ordered action space, rendered beneath its line.
function deviceActionLines(device: Device): string[] {
  const actions = deviceActions(device)
  if (actions.length === 0) return []
  const dims = actions.map((action, index) => {
    const what = action.component ?? action.joint ?? "?"
    const units = action.units ? ` (${action.units})` : ""
    return `      [${index}] ${what}${units}${action.meaning ? ` — ${action.meaning}` : ""}`
  })
  return [`      actions (${actions.length} dims, device-local):`, ...dims]
}

function statusLines(plan: ReadinessPlan): string[] {
  const lines: string[] = []
  const ready = plan.items.find((item) => item.id === "task-ready")
  lines.push(
    `  profile completeness: ${plan.counts.done}/${plan.items.length} items done${ready?.status === "done" ? " — profiles complete" : plan.next.length > 0 ? `; next: ${plan.next.map((item) => item.id).slice(0, 3).join(", ")}` : ""}`,
  )
  if (plan.needed.length > 0)
    lines.push(
      `  needs calibration: ${plan.needed.map((item) => item.id).join(", ")}`,
    )
  return lines
}

// The robotics analog of opencode's <env> block: what the model knows about the
// workspace robot, included in host runtime context. Computed straight from the
// profiles (manifest + device files) so it can never go stale. The scene is
// deliberately absent: it is observed at task time through the robot's sensors,
// never stored or interviewed.
export async function renderRobotSummary(cwd: string, snapshot?: ProfileSnapshot): Promise<string> {
  const state = snapshot ?? await ProfileStore.snapshot(cwd)
  const robot = state.robot
  if (!robot)
    return [
      "<robot>",
      "  No robot is configured in this workspace yet.",
      "  Use profile_write to configure workspace facts and /register to prepare device profiles.",
      "</robot>",
    ].join("\n")

  const robotID = robot.identity.id
  const plan = await readinessPlan(cwd, state)

  const identity = robot.identity
  const lines: string[] = []
  lines.push(
    `<robot id="${robotID}" platform="${identity.platform}" kind="${identity.kind}"${known(identity.model) ? ` model="${identity.model}"` : ""}>`,
  )
  const sim = robot.sim
  if (sim)
    lines.push(
      `  simulator: ${sim.simulator}${sim.notes ? ` — ${sim.notes}` : ""}`,
    )

  const devices = state.devices
  if (devices.length > 0) {
    lines.push(`  profiles: ${await ProfileStore.workspaceDir(cwd)}/devices/<name>/profile.yaml`)
    lines.push("  devices (each commanded in its OWN action space — see the device tool):")
    for (const device of devices) {
      lines.push(deviceLine(device))
      lines.push(...deviceActionLines(device))
    }
    lines.push(...mountTreeLines(devices))
    const unloaded = devices.filter((device) => !device.loaded)
    if (unloaded.length > 0)
      lines.push(
        `    [UNLOADED] devices are out of service: do not read from or calibrate ${unloaded.map((device) => device.name).join(", ")} — activate them through the device tool (action="load") or /load <device>.`,
      )
  }

  lines.push(...statusLines(plan))
  lines.push("</robot>")

  return lines.join("\n")
}

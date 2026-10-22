import { deviceFrames } from "../device/profile/frames.ts"
import { ProfileStore, type ProfileSnapshot } from "../device/profile/store.ts"
import { readinessPlan, type ReadinessPlan } from "../device/profile/readiness.ts"
import { deviceMount, known, type Device } from "../device/profile/schema.ts"

function deviceLine(device: Device): string {
  return `    ${device.name} (${device.type})${device.loaded ? "" : " [UNLOADED]"}`
}

// Mounts use explicit device frames; moving frames resolve from observations.
function mountTreeLines(devices: Device[]): string[] {
  const byName = new Map(devices.map((device) => [device.name, device]))
  const children = new Map<string, { name: string; note: string }[]>()
  const unplaced: string[] = []
  for (const device of devices) {
    if (device.type === "world" || device.type === "model") continue
    const mount = deviceMount(device)
    if (mount === undefined || !known(mount)) {
      // Independent roots and non-spatial devices have no mount to report.
      const base = deviceFrames(device).base
      if (!base || base.parent === null) continue
      unplaced.push(device.name)
      continue
    }
    const parent = byName.get(mount.parent)
    const frames = parent ? deviceFrames(parent) : {}
    const onNamedFrame = Object.hasOwn(frames, mount.parent_frame ?? "")
    const notes: string[] = []
    if (onNamedFrame) notes.push(`on ${mount.parent_frame}`)
    else if (mount.parent_frame && mount.parent_frame !== mount.parent) notes.push(`on ${mount.parent_frame}`)
    if (mount.translation_m === null || mount.rotation_xyzw === null) notes.push("pose unknown")
    const list = children.get(mount.parent) ?? []
    list.push({ name: device.name, note: notes.length > 0 ? ` (${notes.join(", ")})` : "" })
    children.set(mount.parent, list)
  }
  if (children.size === 0 && unplaced.length === 0) return []
  const lines = ["  frame tree (mounts and measured roots; named frames are declared in profiles):"]
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
  if (unplaced.length > 0) lines.push(`    unplaced (base transform unknown): ${unplaced.sort().join(", ")}`)
  return lines
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
    `<robot id="${robotID}" kind="${identity.kind}"${known(identity.model) ? ` model="${identity.model}"` : ""}>`,
  )
  const devices = state.devices
  if (devices.length > 0) {
    lines.push(`  profiles: ${await ProfileStore.workspaceDir(cwd)}/devices/<name>/profile.yaml`)
    lines.push("  devices:")
    for (const device of devices) {
      lines.push(deviceLine(device))
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

import { parse as parseYaml } from "yaml"
import { NamedError } from "../../util/error.ts"
import { z } from "zod"
import { resolveDeviceModel } from "../device-model.ts"
import path from "node:path"
import fs from "node:fs/promises"
import { isDeepStrictEqual } from "node:util"
import { ConfigPaths } from "../../config/paths.ts"
import { exists } from "../../util/filesystem.ts"
import { toYaml } from "../../util/yaml.ts"
import { deepMerge } from "../../util/json.ts"
import { deviceFrames, frameErrors } from "./frames.ts"
import { RobotManifest, Device } from "./schema.ts"
import { create } from "../../util/log.ts"

const log = create("calibration")
const object = z.record(z.string(), z.unknown())

// Explicit replacement applies only to supplied top-level sections.
function mergeSections(existing: Record<string, unknown>, patch: Record<string, unknown>, replace: readonly string[], allowed: readonly string[], removable: readonly string[] = []) {
  const merged = deepMerge(existing, patch)
  for (const key of replace) {
    if (!allowed.includes(key) || !Object.hasOwn(patch, key)) throw new Error(`replace needs a supplied section: ${key}`)
    if (patch[key] === null) {
      if (!removable.includes(key)) throw new Error(`cannot remove required section ${key}`)
      delete merged[key]
      continue
    }
    merged[key] = object.parse(patch[key])
  }
  return merged
}

// One robot configuration per workspace, under .kinex/:
//   workspace.yaml, devices/<name>/{profile.yaml,node.py}, lib/, skills/,
//   setup/plan.json, calib/<run>/, recordings/<id>/.

async function readYaml(file: string): Promise<Record<string, unknown> | undefined> {
  if (!(await exists(file))) return undefined
  let document: unknown
  try { document = parseYaml(await fs.readFile(file, "utf-8")) }
  catch (error) { throw new NamedError("ProfileFileError", `${file}: ${error instanceof Error ? error.message : String(error)}`) }
  const parsed = object.safeParse(document)
  if (!parsed.success) throw new NamedError("ProfileFileError", `${file}: expected a YAML mapping`)
  return parsed.data
}

// What a loaded device's host was started from; it changes only across unload.
function definition({ type, runtime, operations }: Device) {
  return { type, runtime, operations }
}

async function writeYaml(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, toYaml(value))
}

export const ProfileStore = {
  async workspaceDir(cwd: string): Promise<string> {
    return ConfigPaths.projectDir(cwd)
  },

  // A device is a DIRECTORY: its profile plus the utility code that reaches it.
  async deviceDir(cwd: string, name: string): Promise<string> {
    return path.join(await ProfileStore.workspaceDir(cwd), "devices", name)
  },

  async deviceFile(cwd: string, name: string): Promise<string> {
    return path.join(await ProfileStore.deviceDir(cwd, name), "profile.yaml")
  },

  async writeManifest(cwd: string, patch: Record<string, unknown>, replace: readonly string[] = []): Promise<RobotManifest> {
    const file = path.join(await ProfileStore.workspaceDir(cwd), "workspace.yaml")
    const existing = (await readYaml(file)) ?? {}
    const merged = mergeSections(existing, patch, replace, ["identity", "devices", "safety"])
    const now = new Date().toISOString()
    const meta = (merged["meta"] as Record<string, unknown> | undefined) ?? { created_at: now }
    merged["meta"] = { ...meta, updated_at: now }
    const manifest = RobotManifest.parse(merged)
    await writeYaml(file, manifest)
    return manifest
  },

  async readManifest(cwd: string): Promise<RobotManifest | undefined> {
    const raw = await readYaml(path.join(await ProfileStore.workspaceDir(cwd), "workspace.yaml"))
    if (!raw) return undefined
    const parsed = RobotManifest.safeParse(raw)
    if (!parsed.success) {
      log.warn("invalid workspace manifest", { issues: parsed.error.issues.length })
      return undefined
    }
    return parsed.data
  },

  async writeDevice(cwd: string, patch: Record<string, unknown> & { name: string }, replace: readonly string[] = []): Promise<Device> {
    if (typeof patch.name !== "string" || patch.name === "") throw new Error("device patch needs a non-empty name")
    const file = await ProfileStore.deviceFile(cwd, patch.name)
    const existing = (await readYaml(file)) ?? {}
    // Merging across union variants would interleave unrelated fact shapes —
    // a new type or camera layout replaces the file wholesale instead.
    const retyped = ["type", "layout"].some(key => typeof existing[key] === "string" && typeof patch[key] === "string" && existing[key] !== patch[key])
    const merged = mergeSections(retyped ? {} : existing, patch, replace, Object.keys(patch), ["runtime"])
    const now = new Date().toISOString()
    const meta = (retyped ? undefined : (merged["meta"] as Record<string, unknown> | undefined)) ?? { created_at: now }
    merged["meta"] = { ...meta, updated_at: now }
    const parsed = Device.parse(merged)
    if (existing.loaded && existing.runtime && !isDeepStrictEqual(definition(Device.parse(existing)), definition(parsed)))
      throw new Error("unload before changing the device type, runtime or operations")
    const device = await resolveDeviceModel(parsed, path.dirname(file), retyped || ["model", "grip", "home", "frames"].some(key => key in patch))
    await writeYaml(file, device)
    return device
  },

  async readDevice(cwd: string, name: string): Promise<Device | undefined> {
    const raw = await readYaml(await ProfileStore.deviceFile(cwd, name))
    if (!raw) return undefined
    const parsed = Device.safeParse(raw)
    if (!parsed.success) {
      throw new NamedError("DeviceProfileError", `${name}: invalid profile; use top-level facts and frames.base with explicit device:frame parents (null for roots). ${parsed.error.message}`)
    }
    return resolveDeviceModel(parsed.data, await ProfileStore.deviceDir(cwd, name))
  },

  async listDevices(cwd: string): Promise<Device[]> {
    const dir = path.join(await ProfileStore.workspaceDir(cwd), "devices")
    if (!(await exists(dir))) return []
    const devices: Device[] = []
    for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue
      const device = await ProfileStore.readDevice(cwd, entry.name)
      if (device) devices.push(device)
    }
    return devices
  },

  async validateFrames(cwd: string, name: string): Promise<void> {
    const devices = await ProfileStore.listDevices(cwd)
    const required = new Set([name])
    for (const current of required) {
      const device = devices.find(device => device.name === current)
      for (const frame of Object.values(device ? deviceFrames(device) : {}))
        if (frame.parent !== null) required.add(frame.parent.split(":")[0]!)
    }
    const errors = frameErrors(devices.filter(device => required.has(device.name)))
    if (errors.length) throw new NamedError("DeviceFrameError", errors.join("; "))
  },

  // The /load and /unload switch: whether the agent may read from the device.
  async setDeviceLoaded(cwd: string, name: string, loaded: boolean): Promise<Device> {
    const device = await ProfileStore.readDevice(cwd, name)
    if (!device) throw new Error(`unknown device "${name}"`)
    return ProfileStore.writeDevice(cwd, { name, loaded })
  },
}

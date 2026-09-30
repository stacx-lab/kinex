import path from "node:path"
import fs from "node:fs/promises"
import { ProfileStore } from "../device/profile/store.ts"
import { deviceModel } from "../device/device-model.ts"
import { exists, readJson, writeJson } from "../util/filesystem.ts"
import { RecordingManifest } from "./schema.ts"

// Where recordings live: beside the devices and calibration they snapshot.
//   .kinex/recordings/<recording-id>/

export async function recordingsDir(cwd: string): Promise<string> {
  return path.join(await ProfileStore.workspaceDir(cwd), "recordings")
}

export const manifestFile = (dir: string) => path.join(dir, "recording.json")
export const timelineFile = (dir: string) => path.join(dir, "timeline.jsonl")
export const traceFile = (dir: string) => path.join(dir, "trace.json")
export const profileDir = (dir: string) => path.join(dir, "profile")
// Designated devices live under devices/; traffic on any other device the
// agent or a tool touched is tapped under the sibling passive/.
export const deviceDir = (dir: string, name: string, passive = false) => path.join(dir, passive ? "passive" : "devices", name)
export const eventsFile = (dir: string, name: string, passive = false) => path.join(deviceDir(dir, name, passive), "events.jsonl")
export const streamDir = (dir: string, name: string) => path.join(deviceDir(dir, name), "stream")
export const frameFile = (name: string, seq: number, suffix: string, passive = false) =>
  path.join(deviceDir("", name, passive), "frames", `${String(seq).padStart(6, "0")}${suffix}`)

export async function readManifest(dir: string): Promise<RecordingManifest | undefined> {
  const raw = await readJson<unknown>(manifestFile(dir))
  if (raw === undefined) return undefined
  const parsed = RecordingManifest.safeParse(raw)
  return parsed.success ? parsed.data : undefined
}

export async function writeManifest(dir: string, manifest: RecordingManifest): Promise<void> {
  await writeJson(manifestFile(dir), manifest)
}

// Newest first (ids are time-ascending).
export async function listRecordings(cwd: string): Promise<RecordingManifest[]> {
  const root = await recordingsDir(cwd)
  if (!(await exists(root))) return []
  const entries = (await fs.readdir(root)).sort().toReversed()
  const manifests = await Promise.all(entries.map((entry) => readManifest(path.join(root, entry))))
  return manifests.filter((manifest): manifest is RecordingManifest => manifest !== undefined)
}

// Snapshot the profiles the recording runs against: workspace.yaml + every
// devices/<name>/profile.yaml (a few KB — analysis scripts can diff them
// against the live profiles later).
export async function snapshotProfiles(cwd: string, dir: string): Promise<void> {
  const robotDir = await ProfileStore.workspaceDir(cwd)
  const target = profileDir(dir)
  await fs.mkdir(target, { recursive: true })
  const workspace = path.join(robotDir, "workspace.yaml")
  if (await exists(workspace)) await fs.copyFile(workspace, path.join(target, "workspace.yaml"))
  for (const device of await ProfileStore.listDevices(cwd)) {
    const file = await ProfileStore.deviceFile(cwd, device.name)
    if (!(await exists(file))) continue
    const out = path.join(target, "devices", device.name, "profile.yaml")
    await fs.mkdir(path.dirname(out), { recursive: true })
    await fs.copyFile(file, out)
    if (device.type === "joint" || device.type === "dexterous_hand") {
      const model = deviceModel(device)
      if (model) await writeJson(path.join(path.dirname(out), "resolved_model.json"), model)
    }
  }
}

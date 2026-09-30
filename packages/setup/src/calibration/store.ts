import path from "node:path"
import { readdir, rm } from "node:fs/promises"
import { ProfileStore } from "@kinex/core/device/profile/store"
import { CalibrationResult } from "./schema.ts"
import { exists, writeJson } from "@kinex/core/util/filesystem"

export async function writeCalibration(cwd: string, result: CalibrationResult): Promise<string> {
  const name = result.deviceID ? `${result.routine}-${result.deviceID}` : result.routine
  const file = path.join(await ProfileStore.workspaceDir(cwd), "calib", `${name}.json`)
  await writeJson(file, CalibrationResult.parse(result))
  return file
}

export async function removeDevice(cwd: string, name: string): Promise<void> {
  await rm(await ProfileStore.deviceDir(cwd, name), { recursive: true, force: true })
  const directory = path.join(await ProfileStore.workspaceDir(cwd), "calib")
  if (!await exists(directory)) return
  for (const entry of await readdir(directory)) {
    if (entry.endsWith(`-${name}.json`)) await rm(path.join(directory, entry), { force: true })
  }
}

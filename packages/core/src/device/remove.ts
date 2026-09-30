import path from "node:path"
import { readdir, rm } from "node:fs/promises"
import { ProfileStore } from "./profile/store.ts"
import { exists } from "../util/filesystem.ts"

export async function removeDevice(cwd: string, name: string): Promise<void> {
  await rm(await ProfileStore.deviceDir(cwd, name), { recursive: true, force: true })
  const directory = path.join(await ProfileStore.workspaceDir(cwd), "calib")
  if (!await exists(directory)) return
  for (const entry of await readdir(directory)) {
    if (entry.endsWith(`-${name}.json`)) await rm(path.join(directory, entry), { force: true })
  }
}

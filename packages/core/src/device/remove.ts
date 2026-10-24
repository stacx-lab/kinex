import { rm } from "node:fs/promises"
import { ProfileStore } from "./profile/store.ts"

export async function removeDevice(cwd: string, name: string): Promise<void> {
  await rm(await ProfileStore.deviceDir(cwd, name), { recursive: true, force: true })
}

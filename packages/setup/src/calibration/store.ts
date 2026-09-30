import path from "node:path"
import { ProfileStore } from "@kinex/core/device/profile/store"
import { CalibrationResult } from "./schema.ts"
import { writeJson } from "@kinex/core/util/filesystem"

export async function writeCalibration(cwd: string, result: CalibrationResult): Promise<string> {
  const name = result.deviceID ? `${result.routine}-${result.deviceID}` : result.routine
  const file = path.join(await ProfileStore.workspaceDir(cwd), "calib", `${name}.json`)
  await writeJson(file, CalibrationResult.parse(result))
  return file
}

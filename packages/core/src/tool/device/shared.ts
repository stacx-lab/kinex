import type { Device } from "../../device/profile/schema.ts"
import type { DeviceReading } from "../../device/driver.ts"
import type { Result } from "../tool.ts"
import { formatJSON, omitEmptyOptional } from "../../util/json.ts"

// Device routing lives in the device engine; the tool family re-exports it.
export { dispatchDevice } from "../../device/dispatch.ts"

export function noRobot(): Result {
  return {
    title: "no robot configured",
    output: "No robot is configured in this project. Configure the workspace manifest and device profiles first.",
    isError: true,
  }
}

export function unknownDevice(deviceID: string): Result {
  return {
    title: "unknown device",
    output: `no device "${deviceID}" in this workspace — see the <robot> block`,
    isError: true,
  }
}

export function unloadedDevice(device: Device): Result {
  return {
    title: `device ${device.name} is unloaded`,
    output: `device "${device.name}" is unloaded and must not be touched. Use the device tool with action="load" to activate it.`,
    isError: true,
  }
}

// Empty optional feedback does not add information to a model-facing reading.
// Keep faults (even []), timestamps and unfamiliar driver fields intact.
const optionalFeedback = ["velocities", "efforts", "frame_poses"]
const optionalReading = [...optionalFeedback, ...optionalFeedback.map(field => `state.${field}`)]

export function renderReading(reading: DeviceReading, verbose = true, compact = false): string {
  const value = { ...reading.data, ...(reading.filePath ? { file: reading.filePath } : {}) }
  return formatJSON(verbose ? value : omitEmptyOptional(value, optionalReading), compact)
}

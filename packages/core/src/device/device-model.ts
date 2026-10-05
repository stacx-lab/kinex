import type { Device } from "./profile/schema.ts"
import { jointModel, jointModelErrors } from "./profile/joint.ts"
export { resolveJoint as resolveDeviceModel } from "./joint-model.ts"

export function deviceModel(device: Device) {
  return (device.type === "joint" || device.type === "dexterous_hand") ? jointModel(device.intrinsics) : undefined
}

export function deviceModelError(device: Device) {
  return (device.type === "joint" || device.type === "dexterous_hand") ? jointModelErrors.get(device.intrinsics) : undefined
}

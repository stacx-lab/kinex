import type { Device } from "./profile/schema.ts"
import { jointModel, jointModelErrors } from "./profile/joint.ts"
import { resolvedTrees } from "./profile/urdf.ts"
export { resolveJoint as resolveDeviceModel } from "./joint-model.ts"

export function deviceModel(device: Device) {
  if (device.type === "gripper") return device.model === "???" ? undefined : resolvedTrees.get(device.model)
  return (device.type === "joint" || device.type === "dexterous_hand") ? jointModel(device) : undefined
}

export function deviceModelError(device: Device) {
  return ["joint", "dexterous_hand", "gripper"].includes(device.type) ? jointModelErrors.get(device) : undefined
}

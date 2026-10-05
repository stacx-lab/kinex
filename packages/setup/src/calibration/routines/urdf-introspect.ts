import type { Routine } from "./index.ts"
import { nowMeta } from "../schema.ts"
import { deviceModel } from "@kinex/core/device/device-model"
import { ProfileStore } from "@kinex/core/device/profile/store"

export const UrdfIntrospectRoutine: Routine = {
  name: "urdf-introspect",
  description: "Resolve the selected device's own URDF chains",
  platforms: ["real", "sim"],
  requires: "deviceID and intrinsics.model with format:urdf, path, base_link and tip_link",
  run: async (input) => {
    const base = { routine: "urdf-introspect", robotID: input.robot.identity.id, deviceID: input.deviceID, meta: nowMeta("introspected") }
    if (!input.deviceID) return { ...base, status: "failed", notes: "deviceID is required; URDF models belong to devices" }
    const device = await ProfileStore.readDevice(input.cwd, input.deviceID)
    const k = (device?.type === "joint" || device?.type === "dexterous_hand") ? device.intrinsics.model : undefined
    if (!k || k === "???" || k.format !== "urdf")
      return { ...base, status: "failed", notes: "record this device's URDF path, base_link and tip link selection first" }
    const model = (device?.type === "joint" || device?.type === "dexterous_hand") ? deviceModel(device) : undefined
    if (!model) return { ...base, status: "failed", notes: "URDF model reference is incomplete" }
    return { ...base, status: "ok", data: model, notes: `resolved ${model.joints.length} joints; profile retains the URDF reference` }
  },
}

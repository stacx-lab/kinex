import type { Routine } from "./index.ts"
import { nowMeta } from "../schema.ts"
import { deviceTree, modelErrors } from "@kinex/core/device/profile/urdf"
import { ProfileStore } from "@kinex/core/device/profile/store"

export const UrdfIntrospectRoutine: Routine = {
  name: "urdf-introspect",
  description: "Resolve the selected device's own URDF tree",
  platforms: ["real", "sim"],
  requires: "deviceID and model with format:urdf, path and base_link",
  run: async (input) => {
    const base = { routine: "urdf-introspect", robotID: input.robot.identity.id, deviceID: input.deviceID, meta: nowMeta("introspected") }
    if (!input.deviceID) return { ...base, status: "failed", notes: "deviceID is required; URDF models belong to devices" }
    const device = await ProfileStore.readDevice(input.cwd, input.deviceID)
    if (device?.type !== "joint" && device?.type !== "gripper")
      return { ...base, status: "failed", notes: "URDF models belong to joint and gripper devices" }
    const model = deviceTree(device)
    if (!model) return { ...base, status: "failed", notes: modelErrors.get(device) ?? "record this device's URDF path and base_link first" }
    return { ...base, status: "ok", data: model, notes: `resolved ${model.links.length} links and ${model.joints.length} joints; profile retains the URDF reference` }
  },
}

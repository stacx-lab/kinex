import type { Device } from "./profile/schema.ts"
export { lifecycle as LIFECYCLE_ACTIONS } from "./profile/common.ts"

export function isCommandAction(device: Device, action: string): boolean {
  return action === "stop" || device.operations[action]?.direction === "input"
}

import { z } from "zod"
import { loadRawConfig } from "../config/loader.ts"

export const PermissionAction = z.enum(["allow", "ask", "deny"])
export type PermissionAction = z.infer<typeof PermissionAction>
export const PermissionRules = z.record(z.string(), PermissionAction)
export const kinexPermissionPolicy = {
  alwaysAllow: ["device_stop"],
  defaults: { device_act: "ask", device_read: "ask", record: "ask" },
} satisfies { alwaysAllow: string[]; defaults: Record<string, PermissionAction> }

// Preserve valid rules even if another entry is malformed. An invalid explicit
// rule requires a decision rather than silently granting a default permission.
export function permissionRules(value: unknown): Record<string, PermissionAction> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).map(([name, action]) => {
    const parsed = PermissionAction.safeParse(action)
    return [name, parsed.success ? parsed.data : "ask"]
  }))
}

export async function loadPermissionRules(cwd: string) {
  return permissionRules((await loadRawConfig(cwd)).permission)
}

export function kinexPermissionAction(permission: string, rules: Record<string, PermissionAction>, featureDefaults: Record<string, PermissionAction> = {}): PermissionAction {
  if (kinexPermissionPolicy.alwaysAllow.includes(permission)) return "allow"
  const defaults: Record<string, PermissionAction> = kinexPermissionPolicy.defaults
  return rules[permission] ?? featureDefaults[permission] ?? defaults[permission] ?? "ask"
}

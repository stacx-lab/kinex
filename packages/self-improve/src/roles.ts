// Every Kinex process loads this package. A child session is told its role
// through the environment; a session without one is the user's own.
export type Role = "worker" | "distiller" | "helper"

export const ROLE_VARIABLE = "KINEX_SELF_IMPROVE_ROLE"
export const DEADLINE_VARIABLE = "KINEX_SELF_IMPROVE_DEADLINE"

// What a child is sent before its prompt, and which of the package's tools it gets.
export const roles: Record<Role, { first: readonly string[]; tools: readonly string[] }> = {
  worker: { first: ["/load all"], tools: [] },
  distiller: { first: [], tools: ["improve_delegate", "improve_wait", "improve_check"] },
  helper: { first: [], tools: [] },
}

// The user's session gets these once /self-improve has started or resumed a run in it.
export const schedulerTools: readonly string[] = ["improve_tasks", "improve_run_trial", "improve_distill", "improve_wait", "improve_status"]

export function currentRole(): Role | undefined {
  const value = process.env[ROLE_VARIABLE]
  return value === "worker" || value === "distiller" || value === "helper" ? value : undefined
}

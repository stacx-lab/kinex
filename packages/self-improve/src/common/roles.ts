// Every Kinex process loads this package. A worker or a distiller is a child process
// told its role through the environment; a process without one is the user's own.
export type Role = "worker" | "distiller"

export const ROLE_VARIABLE = "KINEX_SELF_IMPROVE_ROLE"

// What a child is sent before its prompt.
export const first: Record<Role, readonly string[]> = { worker: ["/load all"], distiller: [] }

export function currentRole(): Role | undefined {
  const value = process.env[ROLE_VARIABLE]
  return value === "worker" || value === "distiller" ? value : undefined
}

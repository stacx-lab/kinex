// Every Kinex process loads this package. A child of a run, such as a worker or a
// distiller, is a process told through the environment which strategy's child it
// is and in which role, `<strategy>/<role>`; a process without one is the user's own.
export const ROLE_VARIABLE = "KINEX_SELF_IMPROVE_ROLE"

/** A kind of child a strategy runs in a sandbox: how it is started and what it may write. */
export interface Role {
  strategy: string
  name: string
  /** What the child is sent before its prompt. */
  first: readonly string[]
  /**
   * Whether the child starts sub-agents of its own. pi-subagents keeps what they leave (their sessions,
   * artifacts and exports) beside the session file, so such a child writes its whole record; one that starts
   * none writes only its transcript, and pi-subagents is closed to it.
   */
  subagents: boolean
}

export const roleName = (role: Pick<Role, "strategy" | "name">) => `${role.strategy}/${role.name}`

/** The strategy and role this process is a child in, or undefined in the user's own Kinex. */
export function currentRole(): Pick<Role, "strategy" | "name"> | undefined {
  const [strategy, name, ...more] = process.env[ROLE_VARIABLE]?.split("/") ?? []
  return strategy && name && !more.length ? { strategy, name } : undefined
}

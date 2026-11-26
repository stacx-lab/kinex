import type { Role } from "../../common/roles.ts"
import { STRATEGY } from "./names.ts"

// A worker does its task itself, with every skill of its workspace loaded, and starts no sub-agents.
export const WORKER: Role = { strategy: STRATEGY, name: "worker", first: ["/load all"], subagents: false }
// A distiller turns the records into a library with sub-agents of its own, which run in its sandbox.
export const DISTILLER: Role = { strategy: STRATEGY, name: "distiller", first: [], subagents: true }

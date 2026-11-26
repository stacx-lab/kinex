import type { Task } from "./sim.ts"

// What every strategy's plan has: the user approves it before anything exists,
// and how kinex-sim is run is the session's to work out from what the user said.

/** The permission a plan asks for to go on with nobody to approve its steps; the host asks the user once. */
export const UNATTENDED = "unattended"

/** The command parameter of a plan tool. */
export const COMMAND = "the command that runs kinex-sim where it is not `kinex-sim` on PATH: words without quoting, the environment it needs first as NAME=value, e.g. CUDA_VISIBLE_DEVICES=1 /sim/kinex-sim/.venv/bin/kinex-sim"

/** The launch parameter of a plan tool (sim.ts refuses the options that are not the plan's). */
export const LAUNCH = "more options for every `kinex-sim launch` of the run, each word an item, e.g. [\"--split\", \"target\"]. {record} in an option is each episode's own record folder, for what must not be shared, e.g. [\"--record\", \"{record}/video\"]. The execution mode, the early stop and the ROS domain are not yours to give"

/** The ids as a run's tasks: every one in the catalog, all on one robot. */
export function checked(ids: readonly string[], catalog: readonly Task[]): string[] {
  const robots = new Map(catalog.map(task => [task.id, task.robot]))
  const unknown = ids.filter(id => !robots.has(id))
  if (unknown.length) throw new Error(`Unknown tasks: ${unknown.join(", ")}; \`kinex-sim tasks list\` lists the ids`)
  const used = [...new Set(ids.map(id => robots.get(id)))]
  if (used.length !== 1) throw new Error(used.length ? `The tasks use different robots (${used.join(", ")}); a run practises on one` : "A run needs at least one task")
  return [...new Set(ids)].sort()
}

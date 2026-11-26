import { openRun, openRunAt } from "../../common/run.ts"
import type { Strategy } from "../../common/strategy.ts"
import { writeAgents } from "./agents.ts"
import { jobs } from "./jobs.ts"
import { versionDir } from "./layout.ts"
import { PARTS, install, installedBrief, versions } from "./library.ts"
import { NEXT, STRATEGY } from "./names.ts"
import { renderStatus, scan } from "./records.ts"
import type { Config } from "./run.ts"
import { jobFolders, live } from "./scheduler.ts"
import { toolNames, tools } from "./tools.ts"
import PLAN from "./plan.txt"

// code-as-skill: practise many tasks in rounds, a wave of trials and then one
// distillation that turns their records into the next version of a library of
// skills and kinex.lib code, so that later workers, and tasks never practised,
// start from what earlier ones learned. A version is installed into a workspace
// like any skills and code.
export const codeAsSkill: Strategy = {
  name: STRATEGY,
  description: "Practise simulated tasks and distill a library of skills and code",
  arguments: "<what to practise> | status [run] | install <version> [run] | resume [run] | stop",
  next: NEXT,
  toolNames,
  tools,
  plan: request => PLAN.trim().replaceAll("$REQUEST", () => request),
  async resume(root) {
    const run = await openRunAt<Config>(root)
    await writeAgents(root)
    return `The ${STRATEGY} run ${root} (${run.config.selection}) is scheduled in this Kinex again. Call ${NEXT} and do what it says: it gives the calls of the subagent tool that start the next sub-agents. Do not attempt the tasks yourself.`
  },
  async status(root) {
    const status = await scan(root)
    const running = await live(root)
    return renderStatus(root, status, id => running.has(id))
  },
  jobFolders,
  jobs,
  subcommands: {
    // A run is one of this workspace's by name, or any run by its folder.
    async install([version, name, ...more], { directory, kinex }) {
      if (!version || more.length) throw new Error(`Usage: /${STRATEGY} install <version> [run]`)
      const run = await openRun(kinex, STRATEGY, name)
      // A folder that is not a published version would install as an empty library.
      const known = await versions(run.root)
      if (!known.includes(version)) throw new Error(`No library version ${version} in ${run.root}; versions: ${known.join(", ")}`)
      const installed = await install(versionDir(run.root, version), directory)
      return `Installed ${version} of ${run.root}: ${PARTS.map(part => `${part} ${installed[part].join(", ") || "none"}`).join("; ")}`
    },
  },
  choices: async root => root ? (await versions(root)).map(version => `install ${version}`) : [],
  // An installed library's brief is a context section of every session in that
  // workspace, not an instruction: the host sends it before the first request,
  // again only when it changes and after compaction, and the stable prompt stays
  // the same when a library is installed or its brief is edited.
  context: async directory => ({ brief: await installedBrief(directory) }),
}

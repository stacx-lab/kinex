import type { Strategy } from "../../common/strategy.ts"

// code-as-policy: practise one simulated task over many episodes, under other
// seeds and layouts, until one program does it in all of them, and return that
// program. Not implemented yet: this is where it goes.
//
// From common/ it would take what code-as-skill does (strategies/code-as-skill/):
// openRun/createRun for its runs under .kinex/self-improve/code-as-policy/runs/,
// openSim with an episode's seed and --layout-id/--style-id launch options,
// a Role and runSession for its workers in the sandbox, sharePython and
// preparePython for the workspace's Python, spaced and judged for an episode,
// openJob and finishJob for its jobs, writeAgents for the pi-subagents agents
// they run as, alone, live, stopJobs and Refused for its scheduler, and
// UNATTENDED and COMMAND for its plan. What it adds is its own: the plan tool and
// its next tool (policy_plan, policy_next), which episodes a round tries, how a
// program is judged across them, and what a run returns.
export const STRATEGY = "code-as-policy"

const NOT_YET = `/${STRATEGY} is not implemented yet`
const notYet = async (): Promise<never> => { throw new Error(NOT_YET) }

export const codeAsPolicy: Strategy = {
  name: STRATEGY,
  description: "Practise one simulated task over seeds and layouts until a program does it (not implemented yet)",
  arguments: "<task to practise> | status [run] | resume [run] | stop",
  next: "policy_next",
  toolNames: [],
  tools: () => [],
  plan: () => { throw new Error(NOT_YET) },
  resume: notYet,
  status: notYet,
  jobFolders: () => [],
  jobs: {},
}

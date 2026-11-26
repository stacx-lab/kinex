// What the strategy and its parts are called by.

/** Its command, its folder under a workspace's .kinex/self-improve/, and the prefix of its job agents. */
export const STRATEGY = "code-as-skill"

// The tools of the session that plans and schedules a run, and the distiller's gate.
export const PLAN = "skill_plan"
export const NEXT = "skill_next"
export const CHECK = "skill_check"

// The pi-subagents agents its jobs run as (common/agents.ts).
export const TRIAL = "trial"
export const DISTILL = "distill"
export const TRIAL_AGENT = `${STRATEGY}-${TRIAL}`
export const DISTILL_AGENT = `${STRATEGY}-${DISTILL}`

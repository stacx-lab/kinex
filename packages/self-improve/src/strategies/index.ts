import type { Strategy } from "../common/strategy.ts"
import { codeAsPolicy } from "./code-as-policy/index.ts"
import { codeAsSkill } from "./code-as-skill/index.ts"

/** Every self-improvement strategy, each a command of its own. */
export const STRATEGIES: readonly Strategy[] = [codeAsSkill, codeAsPolicy]

export const strategyNamed = (name: string) => STRATEGIES.find(strategy => strategy.name === name)

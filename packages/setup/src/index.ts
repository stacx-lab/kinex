export { createKinexSetup, setupToolNames, type KinexSetup } from "./runtime.ts"
export { setupContribution } from "./integration.ts"
export { setupSkillRoots } from "./assets.ts"
export { workflows } from "./workflows/index.ts"
export const setupPermissionDefaults = { setup_plan: "allow", calib_compute: "ask" } as const
export type { Plan, PlanNode, Outcome, Fact } from "./planning/schema.ts"
export type { ComputeInput } from "./calibration/compute.ts"
export type { SetupHost, SetupOptions, TerminalResult } from "./host.ts"

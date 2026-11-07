export { createKinexSetup, setupToolNames, type KinexSetup } from "./runtime.ts"
export { setupContribution } from "./integration.ts"
export { setupSkillRoots } from "./assets.ts"
export const setupPermissionDefaults = { setup_plan: "allow", calib_compute: "ask" } as const

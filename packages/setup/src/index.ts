export { createKinexSetup, setupToolNames, type KinexSetup } from "./runtime.ts"
export { setupContribution } from "./integration.ts"
export { setupSkillRoots, setupLibRoots } from "./assets.ts"
export const setupPermissionDefaults = { setup_plan: "allow" } as const

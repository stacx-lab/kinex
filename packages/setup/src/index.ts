export { createKinexSetup, setupToolNames, type KinexSetup } from "./runtime.ts"
export { setupContribution } from "./integration.ts"
export { setupSkillRoots } from "./assets.ts"
export { workflows } from "./workflows/index.ts"
export const setupPermissionDefaults = { device_calibrate: "ask", calib_write: "allow" } as const
export type { CalibrationPlan } from "./calibration/plan.ts"

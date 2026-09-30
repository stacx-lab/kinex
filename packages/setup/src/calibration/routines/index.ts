import type { RobotManifest } from "@kinex/core/device/profile/schema"
import type { CalibrationResult } from "../schema.ts"
import { UrdfIntrospectRoutine } from "./urdf-introspect.ts"

// Built-in calibration routines: introspection only — reading facts that are
// already on disk (the device-owned model). Real-robot MEASUREMENT
// procedures are delivered as skills (driven by the needs-calibration queue),
// persisting results via calib_write. Simulated embodiments introspect
// themselves OUTSIDE the harness: such a workspace ships its device profiles.

export interface RoutineInput {
  cwd: string
  robot: RobotManifest
  deviceID?: string
}

export interface Routine {
  name: string
  description: string
  platforms: ("real" | "sim")[]
  requires: string
  run(input: RoutineInput): Promise<CalibrationResult>
}

export const ROUTINES: Routine[] = [UrdfIntrospectRoutine]

export function getRoutine(name: string): Routine | undefined {
  return ROUTINES.find((routine) => routine.name === name)
}

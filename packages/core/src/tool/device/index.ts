import type { Def } from "../tool.ts"
import { DevicesTool } from "./devices.ts"
import { DeviceTool } from "./device.ts"
import { DeviceStopTool } from "./device_stop.ts"
import { DeviceCalibrateTool } from "./device_calibrate.ts"
import { CalibSampleTool } from "./calib_sample.ts"
import { CalibWriteTool } from "./calib_write.ts"
import { CalibPlanTool } from "./calib_plan.ts"

// The robotics tool family — device-scoped throughout: devices are the unit of
// access and action, and there are no robot-level motion tools. `device` is the
// raw dispatch onto one device's driver interface; `device_stop` is the
// always-permitted safety stop; the calib_* tools manage the profiles.
export const DeviceTools: Def[] = [
  DeviceTool,
  DevicesTool,
  DeviceStopTool,
  DeviceCalibrateTool,
  CalibSampleTool,
  CalibWriteTool,
  CalibPlanTool,
]

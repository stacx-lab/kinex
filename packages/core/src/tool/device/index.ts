import type { Def } from "../tool.ts"
import { DevicesTool } from "./devices.ts"
import { DeviceTool } from "./device.ts"
import { DeviceStopTool } from "./device_stop.ts"

// The robotics tool family — device-scoped throughout: devices are the unit of
// access and action, and there are no robot-level motion tools. `device` is the
// raw dispatch onto one device's driver interface; `device_stop` is the
// always-permitted safety stop; setup tools manage provisioning and calibration.
export const DeviceTools: Def[] = [
  DeviceTool,
  DevicesTool,
  DeviceStopTool,
]

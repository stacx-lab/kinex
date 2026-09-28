import path from "node:path"
import { Assets } from "../installation/assets.ts"
import { CalibrationStore } from "../calibration/store.ts"
import { renderCalibrationSummary } from "../calibration/summary.ts"
import { deviceContentRoots, deviceConventions } from "../device/template.ts"
import { pythonEnvironment } from "../python/environment.ts"
import { Recorder } from "../record/recorder.ts"
import { listSkills, formatSkills } from "../skill/index.ts"
import ROBOTICS from "./robotics.txt"
import DEVICE_USE from "./device-use.txt"
import PYTHON from "./python.txt"
export { DEVICE_USE, PYTHON }

// Structured sections let each host place stable instructions ahead of live
// state without importing the standalone agent's identity or system prompt.
export async function roboticsContext(directory: string, enableRecording = false) {
  const [snapshot, skills, roots, python] = await Promise.all([
    CalibrationStore.snapshot(directory), listSkills(directory), deviceContentRoots(directory), pythonEnvironment(directory),
  ])
  const [robotics, conventions] = await Promise.all([
    renderCalibrationSummary(directory, snapshot),
    deviceConventions(directory, snapshot.devices.filter((device) => device.loaded).map((device) => device.type)),
  ])
  return {
    instructions: [ROBOTICS, PYTHON, DEVICE_USE].join("\n\n"),
    guideRoots: `Device guide roots (nearest first): ${roots.join(", ")}. Setup: load the setup-device skill.`,
    // Execution environments include inherited credentials; only paths/readiness
    // belong in model context. python.prepare()/status() retain the process env.
    python: {
      project: python.project, venv: python.venv, executable: python.executable, present: python.present,
      library: Assets.python(), workspaceLibrary: path.join(await CalibrationStore.workspaceDir(directory), "lib"),
    },
    robotics,
    conventions,
    skills: skills.length ? formatSkills(skills) : undefined,
    recording: enableRecording ? Recorder.render() : undefined,
  }
}

import path from "node:path"
import { Assets } from "../installation/assets.ts"
import { ProfileStore } from "../device/profile/store.ts"
import { readinessPlan } from "../device/profile/readiness.ts"
import { renderRobotSummary } from "./robot.ts"
import { deviceContentRoots, deviceConventions } from "../device/conventions.ts"
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
    ProfileStore.snapshot(directory), listSkills(directory), deviceContentRoots(directory), pythonEnvironment(directory),
  ])
  const [robotics, conventions, readiness] = await Promise.all([
    renderRobotSummary(directory, snapshot),
    deviceConventions(directory, snapshot.devices.filter((device) => device.loaded)),
    readinessPlan(directory, snapshot),
  ])
  return {
    instructions: [ROBOTICS, PYTHON, DEVICE_USE].join("\n\n"),
    guideRoots: `Device guide roots (nearest first): ${roots.join(", ")}.`,
    // Execution environments include inherited credentials; only paths/readiness
    // belong in model context. python.prepare()/status() retain the process env.
    python: {
      project: python.project, venv: python.venv, executable: python.executable, present: python.present,
      library: Assets.python(), workspaceLibrary: path.join(await ProfileStore.workspaceDir(directory), "lib"),
    },
    robotics,
    readiness: readiness.items.map(item => `${item.id}: ${item.status} — ${item.detail}${item.dependsOn.length ? ` (requires: ${item.dependsOn.join(", ")})` : ""}`).join("\n"),
    conventions,
    skills: skills.length ? formatSkills(skills) : undefined,
    recording: enableRecording ? Recorder.render() : undefined,
  }
}

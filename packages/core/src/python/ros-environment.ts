import path from "node:path"
import { mkdir, writeFile, rm } from "node:fs/promises"
import { spawnProcess, which } from "../util/process.ts"
import { NamedError } from "../util/error.ts"
import { Assets } from "../installation/assets.ts"
import PROJECT from "./ros-project.txt"

export function overlayCommand(executable: string, overlays: string[]) {
  return overlays.length
    ? ["bash", "-c", 'count="$1"; shift; for ((i=0;i<count;i++)); do source "$1" || exit; shift; done; exec "$@"', "kinex-python", String(overlays.length), ...overlays, executable]
    : [executable]
}

export async function prepareRosPython(project: string, interfaces: string[], env: NodeJS.ProcessEnv, signal?: AbortSignal) {
  await mkdir(project, { recursive: true })
  await writeFile(path.join(project, "pixi.toml"), PROJECT, { flag: "wx" }).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") return
    throw error
  })
  const pixi = await which("pixi")
  if (!pixi) throw new NamedError("PythonEnvironmentError", "Install Pixi to prepare the independent Kinex ROS Python environment.")
  await rm(path.join(project, "ros-ready.json"), { force: true })
  async function run(command: string[], cwd: string) {
    const proc = spawnProcess(command, { cwd, env, signal, group: true, stdout: "pipe", stderr: "pipe" })
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ])
    signal?.throwIfAborted()
    if (code) throw new NamedError("PythonEnvironmentError", `Kinex ROS preparation failed:\n${err || out}`)
  }
  await run([pixi, "install", "--manifest-path", path.join(project, "pixi.toml")], project)
  const prefix = path.join(project, ".pixi/envs/default")
  const workspace = path.join(project, "ros")
  await mkdir(workspace, { recursive: true })
  await run([...overlayCommand(path.join(prefix, "bin/colcon"), [path.join(prefix, "setup.bash")]),
    "build", "--base-paths", Assets.ros(), ...interfaces,
    "--cmake-args", `-DPython3_EXECUTABLE=${path.join(prefix, "bin/python")}`], workspace)
  await run([...overlayCommand(path.join(prefix, "bin/python"), [
    path.join(prefix, "setup.bash"), path.join(workspace, "install/local_setup.bash"),
  ]), "-c", "import rclpy, tf2_ros, tf2_geometry_msgs, rosbag2_py; from kinex_interfaces.srv import Wait; from rclpy.type_support import check_for_type_support; check_for_type_support(Wait)"], project)
  await writeFile(path.join(project, "ros-ready.json"), JSON.stringify({ interfaces }))
}

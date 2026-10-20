import { spawnProcess, which } from "../util/process.ts"
import path from "node:path"
import { mkdir, writeFile, readFile } from "node:fs/promises"
import { exists } from "../util/filesystem.ts"
import { NamedError } from "../util/error.ts"
import { ConfigPaths } from "../config/paths.ts"
import { abortable } from "../util/abort.ts"
import { currentSignal, currentScope } from "../scope.ts"
import PROJECT from "./project.txt"
import { loadRawConfig } from "../config/loader.ts"
import { PythonSettings } from "../config/config.ts"
import { prepareRosPython } from "./ros-environment.ts"

// Core owns a project separate from the host coding agent's Python environment.
export async function pythonEnvironment(cwd: string) {
  const project = path.join(await ConfigPaths.projectDir(cwd), "python")
  const config = PythonSettings.parse(currentScope().settings?.python ?? (await loadRawConfig(cwd))["python"] ?? {})
  const interfaces = config.interfaces.map(source => path.resolve(path.dirname(project), source))
  const venv = path.join(project, config.provider === "ros-jazzy" ? ".pixi/envs/default" : ".venv")
  const bin = path.join(venv, process.platform === "win32" ? "Scripts" : "bin")
  const executable = path.join(bin, process.platform === "win32" ? "python.exe" : "python3")
  const overlays = config.provider === "ros-jazzy" ? [path.join(venv, "setup.bash"), path.join(project, "ros/install/local_setup.bash")] : []
  const receipt = config.provider === "ros-jazzy"
    ? await readFile(path.join(project, "ros-ready.json"), "utf8").catch(() => "") : undefined
  const present = await exists(executable) && (receipt === undefined || receipt === JSON.stringify({ interfaces }))
  const { PYTHONHOME: _home, VIRTUAL_ENV: _venv, UV_PROJECT: _project, UV_PROJECT_ENVIRONMENT: _environment, ...inherited } = process.env
  if (config.provider === "ros-jazzy") {
    for (const key of ["PYTHONPATH", "LD_LIBRARY_PATH", "AMENT_PREFIX_PATH", "CMAKE_PREFIX_PATH", "COLCON_PREFIX_PATH", "CONDA_PREFIX", "ROS_DISTRO", "ROS_VERSION", "ROS_PYTHON_VERSION"]) delete inherited[key]
  }
  const env: NodeJS.ProcessEnv = { ...inherited, UV_PROJECT: project, UV_PROJECT_ENVIRONMENT: venv,
    VIRTUAL_ENV: venv, PATH: [bin, process.env.PATH].filter(Boolean).join(path.delimiter) }
  return {
    project, venv, executable, present, provider: config.provider, overlays, interfaces,
    env,
  }
}

type PythonEnvironment = Awaited<ReturnType<typeof pythonEnvironment>>

async function initialize(runtime: PythonEnvironment) {
  await mkdir(runtime.project, { recursive: true })
  if (runtime.provider === "ros-jazzy") return runtime
  await writeFile(path.join(runtime.project, "pyproject.toml"), PROJECT, { flag: "wx" }).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") return
    throw error
  })
  return runtime
}

// Initialization installs nothing and never touches the ordinary project files.
export async function initializePython(cwd: string) {
  return initialize(await pythonEnvironment(cwd))
}

async function synchronize(runtime: PythonEnvironment, signal?: AbortSignal) {
  signal?.throwIfAborted()
  await initialize(runtime)
  if (runtime.provider === "ros-jazzy") {
    await prepareRosPython(runtime.project, runtime.interfaces, runtime.env, signal)
    return { ...runtime, present: true }
  }
  const uv = await which("uv")
  if (!uv) throw new NamedError("PythonEnvironmentError", "Install uv to prepare Kinex core Python, then run uv sync --project .kinex/python.")
  signal?.throwIfAborted()
  const proc = spawnProcess([uv, "sync", "--project", runtime.project], {
    cwd: runtime.project, env: runtime.env, stdout: "pipe", stderr: "pipe", signal,
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ])
  signal?.throwIfAborted()
  if (code !== 0) throw new NamedError("PythonEnvironmentError",
    `uv sync failed for ${runtime.project} (Python: ${runtime.executable}). Repair dependencies with uv add / uv sync --project ${runtime.project}.\n${stderr || stdout}`)
  if (!(await exists(runtime.executable)))
    throw new NamedError("PythonEnvironmentError", `uv sync did not create ${runtime.executable}`)
  return { ...runtime, present: true }
}

// Preparations are shared by runtimes in this process.
const preparations = new Map<string, Promise<PythonEnvironment>>()
// A failed bootstrap may leave a Python executable before its packages exist.
const incomplete = new Set<string>()
async function prepare(cwd: string, onlyIfMissing: boolean, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const runtime = await pythonEnvironment(cwd)
  signal?.throwIfAborted()
  const { project } = runtime
  const previous = preparations.get(project)
  if (onlyIfMissing && runtime.present && !previous && !incomplete.has(project)) return runtime
  const pending = (previous ?? Promise.resolve()).catch(() => {}).then(async () => {
    signal?.throwIfAborted()
    const present = runtime.provider === "ros-jazzy" ? (await pythonEnvironment(cwd)).present : await exists(runtime.executable)
    signal?.throwIfAborted()
    if (onlyIfMissing && present && !incomplete.has(project)) return { ...runtime, present }
    if (!present) incomplete.add(project)
    const prepared = await synchronize(runtime, signal)
    incomplete.delete(project)
    return prepared
  })
  preparations.set(project, pending)
  void pending.finally(() => {
    if (preparations.get(project) === pending) preparations.delete(project)
  }).catch(() => {})
  return abortable(pending, signal)
}

// Explicit preparation always synchronizes, including an existing environment.
export async function preparePython(cwd: string, signal = currentSignal()) {
  return prepare(cwd, false, signal)
}

export async function pythonRuntime(cwd: string, interpreter?: string, signal = currentSignal()) {
  signal?.throwIfAborted()
  if (interpreter) return { executable: interpreter, overlays: [] as string[], env: { ...process.env } }
  return prepare(cwd, true, signal)
}

export function pythonDiagnostic(message: string, executable: string) {
  return /ModuleNotFoundError|ImportError|No module named/.test(message)
    ? `${message}\nPython interpreter: ${executable}` : message
}

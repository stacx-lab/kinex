import { spawn } from "node:child_process"
import { Readable } from "node:stream"
import { access } from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { currentScope } from "../scope.ts"

export interface ProcessOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  // Shell jobs own their subprocess tree, including pipes inherited by children.
  group?: boolean
  stdin?: "pipe"
  stdout?: "pipe"
  stderr?: "pipe"
}

// Owned Node subprocesses. Writes are acknowledged by the stream,
// stderr can be drained independently, and exit waits for pipe closure.
export function spawnProcess(argv: string[], options: ProcessOptions = {}) {
  const scope = currentScope()
  if (scope.closed) throw new Error("Kinex runtime is disposed")
  const command = argv[0]
  if (!command) throw new Error("process command is required")
  options.signal?.throwIfAborted()
  const group = options.group && process.platform !== "win32"
  const child = spawn(command, argv.slice(1), { cwd: options.cwd, env: options.env, detached: group, stdio: ["pipe", "pipe", "pipe"] })
  const state = { written: Promise.resolve(), timer: undefined as ReturnType<typeof setTimeout> | undefined }
  // Unlike close, exit does not wait for pipes inherited by child processes.
  const exit = new Promise<number>((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", code => resolve(code ?? 128))
  })
  void exit.catch(() => {})
  const exited = new Promise<number>((resolve, reject) => {
    child.once("error", reject)
    child.once("close", (code) => resolve(code ?? 128))
  })
  void exited.catch(() => {})
  child.stdin.on("error", () => {})
  const kill = (signal: NodeJS.Signals) => {
    if (!group || !child.pid) return child.kill(signal)
    try {
      process.kill(-child.pid, signal)
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error
    }
  }
  const terminate = (signal: NodeJS.Signals = "SIGTERM") => {
    if (!group && (child.exitCode !== null || child.signalCode !== null)) return
    kill(signal)
    if (signal !== "SIGKILL" && !state.timer) state.timer = setTimeout(() => kill("SIGKILL"), 1000)
  }
  const abort = () => terminate()
  const proc = {
    pid: child.pid,
    get exitCode() { return child.exitCode ?? (child.signalCode ? 128 : null) },
    stdin: {
      write(data: string | Uint8Array) {
        state.written = new Promise<void>((resolve, reject) => {
          child.stdin.write(data, (error) => error ? reject(error) : resolve())
        })
        void state.written.catch(() => {})
      },
      flush: () => state.written,
      end: () => child.stdin.end(),
    },
    stdout: Readable.toWeb(child.stdout),
    stderr: Readable.toWeb(child.stderr),
    exit,
    exited,
    kill: terminate,
  }
  scope.processes.add(proc)
  options.signal?.addEventListener("abort", abort, { once: true })
  if (options.signal?.aborted) abort()
  void exited.finally(() => {
    clearTimeout(state.timer)
    options.signal?.removeEventListener("abort", abort)
    scope.processes.delete(proc)
  }).catch(() => {})
  return proc
}
export type ManagedProcess = ReturnType<typeof spawnProcess>

export async function which(command: string): Promise<string | undefined> {
  const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""]
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    for (const extension of extensions) {
      const file = path.join(dir, command + extension)
      if (await access(file, constants.X_OK).then(() => true, () => false)) return file
    }
  }
  return undefined
}

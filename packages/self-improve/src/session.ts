import { createWriteStream, existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { spawnProcess } from "@kinex/core/util/process"
import { kinex, modelFlags } from "./kinex.ts"
import { outputFile, promptFile, sessionFile } from "./layout.ts"
import { ROLE_VARIABLE, first, type Role } from "./roles.ts"
import { removeContainer, sandboxed, type Sandbox } from "./sandbox.ts"

export interface SessionExit {
  status: "done" | "timeout" | "error"
  exitCode: number
  wallS: number
}

// The one place a child's command and environment are built; a sandboxed child
// runs the same command inside the sandbox.
function command(role: Role, cwd: string, record: string, prompt: string, sandbox: Sandbox | undefined, image: string | undefined) {
  if (!kinex.entry) throw new Error("Cannot locate the running Kinex entry point")
  const { KINEX_SIM_PROJECT: _project, VIRTUAL_ENV: _venv, ...inherited } = process.env
  // A child is a session of its own, not a sub-agent of the one that scheduled its job.
  for (const name of Object.keys(inherited)) if (name.startsWith("PI_SUBAGENT")) delete inherited[name]
  // kinex-sim is put on PATH by activating its environment; a child never needs it.
  const visible = (entry: string) => !(existsSync(path.join(entry, "kinex-sim")) && existsSync(path.join(entry, "activate")))
  const argv = [process.execPath, kinex.entry, "run", "--yolo", ...modelFlags(), "--session", sessionFile(record), "--", ...first[role], prompt]
  const env = { ...inherited, [ROLE_VARIABLE]: role,
    // A worker does its task itself: it starts no sub-agents. A distiller starts its own, so its
    // Kinex opens pi-subagents from the start.
    ...(role === "worker" ? { PI_SUBAGENT_MAX_DEPTH: "0" } : { KINEX_SUBAGENTS: "on" }),
    PATH: (process.env.PATH ?? "").split(path.delimiter).filter(visible).join(path.delimiter) }
  // A container is named so that it can be removed when the command that started it was killed.
  const container = sandbox === "docker" ? `kinex-self-improve-${process.pid}-${path.basename(path.dirname(record))}-${Date.now()}` : undefined
  return { argv: sandbox ? sandboxed(argv, cwd, sessionFile(record), sandbox, { name: container, image, env }) : argv, env, container }
}

/**
 * Runs one headless Kinex in `cwd` and leaves its record in `record`: the prompt,
 * the transcript Kinex writes into the session file it is given, and its output.
 * A sandboxed child can write only `cwd`, its transcript and Kinex's agent
 * folder. With `resume` the child goes on in the session the record already
 * holds. The child ends at `deadline` or when `signal` aborts.
 */
export async function runSession(role: Role, cwd: string, record: string, prompt: string, deadline: number, options: { sandbox?: Sandbox; image?: string; resume?: boolean; signal?: AbortSignal } = {}): Promise<SessionExit> {
  await mkdir(record, { recursive: true })
  if (!options.resume) {
    await writeFile(promptFile(record), prompt)
    // An empty file opens as a fresh session.
    await writeFile(sessionFile(record), "")
  }
  const started = Date.now()
  const { argv, env, container } = command(role, cwd, record, prompt, options.sandbox, options.image)
  const child = spawnProcess(argv, { cwd, env, group: true, signal: options.signal })
  child.stdin.end()
  const log = createWriteStream(outputFile(record), { flags: "a" })
  const copy = async (stream: ReadableStream<Uint8Array>) => { for await (const chunk of stream) log.write(chunk) }
  const output = Promise.allSettled([copy(child.stdout), copy(child.stderr)])
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; child.kill() }, Math.max(0, deadline - Date.now()))
  const exitCode = await child.exit.finally(() => clearTimeout(timer))
  if (container) await removeContainer(container)
  await output
  await new Promise(resolve => log.end(resolve))
  return { status: timedOut ? "timeout" : exitCode === 0 ? "done" : "error", exitCode, wallS: Math.round((Date.now() - started) / 1000) }
}

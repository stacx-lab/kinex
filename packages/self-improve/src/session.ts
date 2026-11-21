import { createWriteStream, existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { spawnProcess } from "@kinex/core/util/process"
import { outputFile, promptFile, sessionFile } from "./layout.ts"
import { ROLE_VARIABLE, first, type Role } from "./roles.ts"
import { sandboxed } from "./sandbox.ts"

export interface SessionExit {
  status: "done" | "timeout" | "error"
  exitCode: number
  wallS: number
}

// A child runs on the model this Kinex was started with: its --model, --provider
// and --thinking pass on, and without them the child takes the same settings defaults.
function modelFlags(args = process.argv.slice(2)): string[] {
  const flags: string[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === "--") break
    const name = ["--model", "--provider", "--thinking"].find(flag => arg === flag || arg.startsWith(`${flag}=`))
    if (!name) continue
    const value = arg === name ? args[++index] : arg.slice(name.length + 1)
    if (value) flags.push(name, value)
  }
  return flags
}

// The one place a child's command and environment are built; a sandboxed child
// runs the same command inside the sandbox.
function command(role: Role, cwd: string, record: string, prompt: string, sandbox: boolean) {
  const kinex = process.argv[1]
  if (!kinex) throw new Error("Cannot locate the running Kinex entry point")
  const { ROSBRIDGE_PROJECT: _project, VIRTUAL_ENV: _venv, ...inherited } = process.env
  // rosbridge is put on PATH by activating its environment; a child never needs it.
  const visible = (entry: string) => !(existsSync(path.join(entry, "rosbridge")) && existsSync(path.join(entry, "activate")))
  const argv = [process.execPath, kinex, "run", "--yolo", ...modelFlags(), "--session", sessionFile(record), "--", ...first[role], prompt]
  return {
    argv: sandbox ? sandboxed(argv, cwd, sessionFile(record)) : argv,
    env: { ...inherited, [ROLE_VARIABLE]: role,
      PATH: (process.env.PATH ?? "").split(path.delimiter).filter(visible).join(path.delimiter) },
  }
}

/**
 * Runs one headless Kinex in `cwd` and leaves its record in `record`: the prompt,
 * the transcript Kinex writes into the empty session file it is given, and its
 * output. Workers and helpers are started here; a sandboxed one can write only
 * `cwd`, its transcript and Kinex's agent folder. The child ends at `deadline`
 * or when `signal` aborts.
 */
export async function runSession(role: Role, cwd: string, record: string, prompt: string, deadline: number, options: { sandbox?: boolean; signal?: AbortSignal } = {}): Promise<SessionExit> {
  await mkdir(record, { recursive: true })
  await writeFile(promptFile(record), prompt)
  await writeFile(sessionFile(record), "")
  const started = Date.now()
  const { argv, env } = command(role, cwd, record, prompt, options.sandbox === true)
  // A helper stays in the process group of the Kinex that distills, so it ends with it.
  const child = spawnProcess(argv, { cwd, env, group: role !== "helper", signal: options.signal })
  child.stdin.end()
  const log = createWriteStream(outputFile(record))
  const copy = async (stream: ReadableStream<Uint8Array>) => { for await (const chunk of stream) log.write(chunk) }
  const output = Promise.allSettled([copy(child.stdout), copy(child.stderr)])
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; child.kill() }, Math.max(0, deadline - Date.now()))
  const exitCode = await child.exit.finally(() => clearTimeout(timer))
  await output
  await new Promise(resolve => log.end(resolve))
  return { status: timedOut ? "timeout" : exitCode === 0 ? "done" : "error", exitCode, wallS: Math.round((Date.now() - started) / 1000) }
}

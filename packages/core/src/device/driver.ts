import type { CommandAdmission } from "./scheduler.ts"
import { scoped } from "../scope.ts"
import { spawnProcess } from "../util/process.ts"
import { pythonDiagnostic } from "../python/environment.ts"
import path from "node:path"
import { ProfileStore } from "./profile/store.ts"
import { pythonLaunch } from "../python/launch.ts"
import { NamedError } from "../util/error.ts"
import { exists } from "../util/filesystem.ts"
import { serveProcess, terminate, type ServeProcess } from "./serve-process.ts"
import { isModel, type Device } from "./profile/schema.ts"

// Runs the agent-authored per-device drivers (devices/<name>/driver.py).
// Requests use stdin JSONL; --serve keeps the connection open with correlated
// replies. One-shot drivers read one request and release temporary resources.


class DriverError extends NamedError {
  constructor(message: string, data: Record<string, unknown> = {}) {
    super("DriverError", message, data)
  }
}

export interface DeviceReading {
  deviceID: string
  kind: string
  // Small payloads inline; large ones (images) written to a file with the path here.
  data?: Record<string, unknown>
  filePath?: string
}

const DRIVER_TIMEOUT_MS = 60_000

// Per-call wall-clock cap; drivers override via access.driver.timeout_s (model
// services initialize during the load request).
function timeoutMs(device: Device): number {
  const seconds = device.access?.driver?.timeout_s
  return seconds !== undefined ? seconds * 1000 : DRIVER_TIMEOUT_MS
}

// The driver's absolute entry path, or undefined when the device declares none.
export async function driverPath(cwd: string, device: Device): Promise<string | undefined> {
  const driver = device.access?.driver
  if (!driver) return undefined
  return path.join(await ProfileStore.deviceDir(cwd, device.name), driver.entry)
}

// Declared AND present on disk — what the access:<device> calibration item checks.
export async function driverExists(cwd: string, device: Device): Promise<boolean> {
  const file = await driverPath(cwd, device)
  if (!file) return false
  return exists(file)
}

function parsePayload(deviceName: string, line: string | undefined): Record<string, unknown> {
  if (!line) throw new DriverError(`driver for "${deviceName}" printed nothing on stdout (expected one JSON object)`)
  const parsed = (() => {
    try {
      return JSON.parse(line) as unknown
    } catch {
      return undefined
    }
  })()
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new DriverError(`driver stdout is not a JSON object: ${line.slice(0, 200)}`)
  return parsed as Record<string, unknown>
}

function toReading(device: Device, payload: Record<string, unknown>, stderr: string, interpreter: string): DeviceReading {
  if (payload["ok"] === false)
    throw new DriverError(pythonDiagnostic(`driver for "${device.name}" failed: ${String(payload["error"] ?? "no error message")}`, interpreter), {
      stderr: stderr.trim(), code: payload["code"], details: payload["details"],
    })
  const { ok: _ok, file: filePath, ...data } = payload
  if (isModel(device) && filePath !== undefined && typeof filePath !== "string")
    throw new DriverError(`model "${device.name}" returned a non-string file path`)
  return {
    deviceID: device.name,
    kind: device.type,
    ...(typeof filePath === "string" ? { filePath } : {}),
    ...(Object.keys(data).length > 0 ? { data } : {}),
  }
}

// --- persistent (--serve) drivers -----------------------------------------

interface DriverProcess extends ServeProcess {
  interpreter: string
  loaded?: boolean
  pending: Map<string, { resolve: (value: Record<string, unknown>) => void; reject: (error: unknown) => void }>
}
const serving = scoped(() => new Map<string, DriverProcess>())

export async function isServing(cwd: string, deviceName: string): Promise<boolean> {
  const entry = serving().get(await ProfileStore.deviceDir(cwd, deviceName))
  return entry !== undefined && entry.stopping === undefined && entry.proc.exitCode === null
}

// The /unload half of the lifecycle: close stdin and await exit (no-op when none).
export async function stopServing(cwd: string, deviceName: string): Promise<void> {
  const key = await ProfileStore.deviceDir(cwd, deviceName)
  const entry = serving().get(key)
  if (!entry) return
  await terminate(entry, true)
  if (serving().get(key) === entry) serving().delete(key)
}

function failServing(entry: DriverProcess, error: unknown): void {
  for (const pending of entry.pending.values()) pending.reject(error)
  entry.pending.clear()
  void terminate(entry)
}

// Control frame, never a model-visible device action. A scoped stop also
// cancels cooperative SDK hooks in the other drivers it physically affects.
export async function interruptServing(cwd: string, name: string, requestID?: string): Promise<void> {
  const entry = serving().get(await ProfileStore.deviceDir(cwd, name))
  if (!entry || entry.stopping || entry.proc.exitCode !== null) return
  const id = crypto.randomUUID()
  const response = Promise.withResolvers<Record<string, unknown>>()
  entry.pending.set(id, response)
  const timer = setTimeout(() => failServing(entry, new DriverError("driver interrupt timed out")), 1000)
  try {
    entry.proc.stdin.write(JSON.stringify({ id, interrupt: requestID ?? true }) + "\n")
    void Promise.resolve(entry.proc.stdin.flush()).catch(error => failServing(entry, error))
    const result = await response.promise
    if (result.ok !== true) throw new DriverError(`driver interrupt failed: ${String(result.error)}`)
  } finally {
    clearTimeout(timer)
  }
}

// Exactly one consumer owns stdout. Deadlines belong to requests, not reads of
// the shared pipe: a fast observation can finish before a bounded write.
async function receive(entry: DriverProcess, device: Device): Promise<void> {
  const decoder = new TextDecoder()
  let buffer = ""
  for (;;) {
    const chunk = await entry.source.next()
    if (chunk.done) throw new DriverError("persistent driver closed its stdout")
    buffer += decoder.decode(chunk.value, { stream: true })
    for (;;) {
      const newline = buffer.indexOf("\n")
      if (newline < 0) break
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      const { id, ...payload } = parsePayload(device.name, line)
      if (typeof id !== "string") throw new DriverError("persistent driver must echo request id; regenerate or migrate the driver and reload it")
      const pending = entry.pending.get(id)
      if (!pending) throw new DriverError(`persistent driver returned unknown or duplicate request id ${id}`)
      entry.pending.delete(id)
      pending.resolve(payload)
    }
  }
}

async function runServe(
  cwd: string,
  device: Device,
  file: string,
  action: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  admission?: CommandAdmission,
): Promise<DeviceReading> {
  const key = await ProfileStore.deviceDir(cwd, device.name)
  const entry = await (async () => {
    const existing = serving().get(key)
    if (existing?.stopping) await existing.stopping
    if (existing && !existing.stopping && existing.proc.exitCode === null) return existing
    if (action !== "load") throw new DriverError(`device "${device.name}" is inactive; load it before ${action}`)
    if (existing) await terminate(existing)
    const runtime = await pythonLaunch(cwd, "driver", device.access?.driver?.interpreter, signal)
    signal?.throwIfAborted()
    const proc = spawnProcess([runtime.executable, file, "--serve"], {
      cwd: path.dirname(file),
      group: true,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: runtime.env,
    })
    const created: DriverProcess = { ...serveProcess(proc), interpreter: runtime.executable, pending: new Map() }
    serving().set(key, created)
    void receive(created, device).catch(error => failServing(created, error))
    return created
  })()
  if (action !== "load" && action !== "unload" && !entry.loaded)
    throw new DriverError(`device "${device.name}" is not ready; load it before ${action}`)
  signal?.throwIfAborted()
  // Stop may have arrived during asynchronous path/environment preparation.
  // Check admission immediately before putting a command on the driver's pipe.
  admission?.check()
  const id = crypto.randomUUID()
  const response = Promise.withResolvers<Record<string, unknown>>()
  entry.pending.set(id, response)
  const abort = () => {
    if (action === "wait") void interruptServing(cwd, device.name, id).catch(error => failServing(entry, error))
    else failServing(entry, signal?.reason ?? new DriverError("driver request aborted"))
  }
  signal?.addEventListener("abort", abort, { once: true })
  const interrupt = () => { void interruptServing(cwd, device.name).catch(error => failServing(entry, error)) }
  admission?.interrupted?.addEventListener("abort", interrupt, { once: true })
  if (admission?.interrupted?.aborted) interrupt()
  const timer = setTimeout(() => failServing(entry, new DriverError("persistent driver timed out")), timeoutMs(device))
  const payload = await (async () => {
    if (signal?.aborted) {
      entry.pending.delete(id)
      response.reject(signal.reason)
    } else {
      entry.proc.stdin.write(JSON.stringify({ id, action, args }) + "\n")
      void Promise.resolve(entry.proc.stdin.flush()).catch(error => failServing(entry, error))
    }
    return response.promise
  })().catch(async (error: unknown) => {
    if (action === "wait" && signal?.aborted) throw error
    failServing(entry, error)
    await terminate(entry)
    if (serving().get(key) === entry) serving().delete(key)
    if (signal?.aborted) throw error
    throw new DriverError(pythonDiagnostic(`driver for "${device.name}" failed: ${String(error)}\n${entry.stderr.tail.trim()}`, entry.interpreter), { stderr: entry.stderr.tail.trim() })
  }).finally(() => {
    clearTimeout(timer)
    admission?.interrupted?.removeEventListener("abort", interrupt)
    signal?.removeEventListener("abort", abort)
  })
  try {
    signal?.throwIfAborted()
    const reading = toReading(device, payload, entry.stderr.tail, entry.interpreter)
    if (action === "load") entry.loaded = true
    return reading
  } catch (error) {
    if (action === "load") await stopServing(cwd, device.name)
    throw error
  }
}

// --- one-shot drivers ------------------------------------------------------

export async function runDriver(
  cwd: string,
  device: Device,
  action: string,
  args: Record<string, unknown> = {},
  signal?: AbortSignal,
  admission?: CommandAdmission,
): Promise<DeviceReading> {
  signal?.throwIfAborted()
  const driver = device.access?.driver
  if (!driver) throw new DriverError(`device "${device.name}" declares no access.driver`)
  const active = driver.persistent && await isServing(cwd, device.name)
  if (action === "status" && !active)
    return { deviceID: device.name, kind: device.type, data: { loaded: device.loaded, ready: false, serving: false, persistent: driver.persistent } }
  if (action === "unload" && !(driver.persistent ? active : device.loaded)) {
    await stopServing(cwd, device.name)
    return { deviceID: device.name, kind: device.type, data: { unloaded: true } }
  }
  if (action === "load") {
    const missing = ["load", "unload", "status"].filter(action => !driver.actions.includes(action))
    if (missing.length) throw new DriverError(`device "${device.name}" driver lacks lifecycle actions: ${missing.join(", ")}`)
  }
  const file = await driverPath(cwd, device)
  if (!file || (!active && !(await exists(file))))
    throw new DriverError(`device "${device.name}" declares driver ${driver.entry} but ${file} does not exist`)
  try {
    return driver.persistent ? await runServe(cwd, device, file, action, args, signal, admission) : await runOnce(cwd, device, file, action, args, signal, admission)
  } finally {
    if (action === "unload") await stopServing(cwd, device.name)
  }
}

async function runOnce(
  cwd: string,
  device: Device,
  file: string,
  action: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  admission?: CommandAdmission,
): Promise<DeviceReading> {
  signal = AbortSignal.any([...(signal ? [signal] : []), ...(admission?.interrupted ? [admission.interrupted] : [])])
  const runtime = await pythonLaunch(cwd, "driver", device.access?.driver?.interpreter, signal)
  signal.throwIfAborted()
  admission?.check()
  const request = JSON.stringify({ action, args }) + "\n"
  const proc = spawnProcess([runtime.executable, file], {
    cwd: path.dirname(file),
    group: true,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: runtime.env,
  })
  const abort = () => proc.kill()
  signal?.addEventListener("abort", abort, { once: true })
  if (signal?.aborted) abort()
  const timeout = setTimeout(abort, timeoutMs(device))
  proc.stdin.write(request)
  proc.stdin.end()
  const sent = proc.stdin.flush().catch((error: unknown) => {
    signal.throwIfAborted()
    throw new DriverError(`cannot send request to driver for "${device.name}": ${error instanceof Error ? error.message : String(error)}`)
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
    sent,
  ]).finally(() => {
    proc.kill("SIGKILL")
    clearTimeout(timeout)
    signal?.removeEventListener("abort", abort)
  })
  signal?.throwIfAborted()
  if (code !== 0)
    throw new DriverError(pythonDiagnostic(`driver for "${device.name}" exited ${code}: ${stderr.trim().slice(0, 500)}`, runtime.executable), { code })

  const line = stdout
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .at(-1)
  return toReading(device, parsePayload(device.name, line), stderr, runtime.executable)
}

export async function closeDrivers(): Promise<void> {
  await Promise.allSettled([...serving().values()].map((entry) => terminate(entry, true)))
  serving().clear()
}

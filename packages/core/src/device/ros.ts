import { overlayCommand } from "../python/ros-environment.ts"
import path from "node:path"
import { readFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { z } from "zod"
import { scoped } from "../scope.ts"
import { serialize } from "../util/serialize.ts"
import { spawnProcess } from "../util/process.ts"
import { shortID } from "../util/id.ts"
import { NamedError } from "../util/error.ts"
import { readLine } from "../util/lines.ts"
import { pythonLaunch } from "../python/launch.ts"
import { ProfileStore } from "./profile/store.ts"
import { serveProcess, terminate, type ServeProcess } from "./serve-process.ts"
import type { Device } from "./profile/schema.ts"
import { urdfSpec } from "./profile/urdf.ts"
import type { DeviceReading } from "./reading.ts"

type Pending = ReturnType<typeof Promise.withResolvers<Record<string, unknown>>>
type Message = Record<string, unknown>
interface Host extends ServeProcess {
  pending: Map<string, Pending>
  definition: string
  ready: boolean
}
/** What serves a running program: the calls it makes of the host, and the text it prints. */
export interface Program {
  call(request: Message): Promise<Message>
  output?: (text: string) => void
}
// A ROS domain's Python runtime: the devices loaded into it, each by its definition, the
// program it runs and its interpreter.
interface Runtime extends Host {
  devices: Map<string, string>
  program?: Program
  clock?: unknown
  executable: string
}
const hosts = scoped(() => new Map<string, Host>())
const runtimes = scoped(() => new Map<string, Runtime>())
const transitions = scoped(() => new Map<string, Promise<void>>())

function resolvedOperations(device: Device) {
  const endpoint = (value: string) => value.startsWith("/") ? value : path.posix.join("/", device.runtime?.namespace ?? "", value)
  return Object.fromEntries(Object.entries(device.operations).map(([name, operation]) => [name, { ...operation, endpoint: endpoint(operation.endpoint) }]))
}

export async function rosLaunch(cwd: string, device: Device, signal?: AbortSignal) {
  if (!device.runtime) throw new NamedError("RosRuntimeError", "missing ROS runtime")
  const directory = await ProfileStore.deviceDir(cwd, device.name)
  const runtime = await pythonLaunch(cwd, "node", device.runtime.interpreter ? path.resolve(directory, device.runtime.interpreter) : undefined, signal)
  const overlays = [...runtime.overlays, ...device.runtime.overlays.map(file => path.resolve(directory, file))]
  return {
    ...runtime,
    command: overlayCommand(runtime.executable, overlays),
    env: { ...runtime.env, ROS_DOMAIN_ID: String(device.runtime.domain_id) },
    directory,
  }
}

async function definition(directory: string, device: Device) {
  const { meta, loaded, ...facts } = device
  const hash = createHash("sha256").update(JSON.stringify(facts))
  for (const node of device.runtime?.nodes ?? []) hash.update(await readFile(path.resolve(directory, node.entry)))
  const spec = urdfSpec(device)
  if (spec) hash.update(await readFile(path.resolve(directory, spec.path)))
  return hash.digest("hex")
}

async function receive(host: Host & { program?: Program }) {
  try {
    for (;;) {
      const line = await readLine(host.source, Date.now() + 2_147_483_647)
      if (line === undefined) throw new Error(`ROS host exited: ${host.stderr.tail}`)
      const result = z.record(z.string(), z.unknown()).parse(JSON.parse(line))
      if ("output" in result) { host.program?.output?.(String(result.output)); continue }
      if ("call" in result) {
        // Answered when it settles, so a slow call, such as a subagent, holds back no other.
        const answer = host.program?.call(result) ?? Promise.resolve({ ok: false, error: "no program is running" })
        void answer.catch((error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }))
          .then(response => host.proc.stdin.write(JSON.stringify({ ...response, id: result.id }) + "\n"))
        continue
      }
      const id = z.string().parse(result.id)
      const pending = host.pending.get(id)
      if (!pending) continue // Cancelled requests may complete after their caller.
      host.pending.delete(id)
      if (result.ok === false) pending.reject(new NamedError("RosOperationError", String(result.error)))
      else pending.resolve(z.record(z.string(), z.unknown()).parse(result.data ?? {}))
    }
  } catch (error) {
    host.ready = false
    for (const pending of host.pending.values()) pending.reject(error)
    host.pending.clear()
  }
}

async function request(host: Host, action: string, args: Record<string, unknown>, signal?: AbortSignal, timeout = 30_000) {
  signal?.throwIfAborted()
  const id = shortID()
  const pending = Promise.withResolvers<Record<string, unknown>>()
  host.pending.set(id, pending)
  const cancel = () => {
    host.proc.stdin.write(JSON.stringify({ id: shortID(), cancel: id }) + "\n")
    pending.reject(signal?.reason ?? new NamedError("RosTimeout", `ROS ${action} timed out`))
  }
  const timer = setTimeout(cancel, timeout)
  signal?.addEventListener("abort", cancel, { once: true })
  try {
    host.proc.stdin.write(JSON.stringify({ id, action, args }) + "\n")
    await host.proc.stdin.flush()
    return await pending.promise
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", cancel)
    host.pending.delete(id)
  }
}

// A world keeps its domain's time on the ROS clock topic, which is not one of its operations.
const CLOCK = { description: "", transport: "topic", direction: "output", endpoint: "/clock", type: "rosgraph_msgs/msg/Clock",
  qos: { depth: 1, reliability: "reliable", durability: "transient_local" } }

/** The domain's clock, if the workspace has a world device there. */
async function worldClock(cwd: string, domain: number) {
  const worlds = (await ProfileStore.listDevices(cwd)).filter(value => value.type === "world" && (value.runtime?.domain_id ?? 0) === domain)
  if (worlds.length > 1) throw new NamedError("RosClockError", "one world is required per ROS domain")
  return worlds.length ? CLOCK : undefined
}

/** The devices whose nodes are up, by their definitions. */
async function readyDevices(cwd: string) {
  const ready: Array<{ device: Device; definition: string }> = []
  for (const device of await ProfileStore.listDevices(cwd)) {
    const host = device.loaded && device.runtime ? hosts().get(await ProfileStore.deviceDir(cwd, device.name)) : undefined
    if (host && await rosReady(cwd, device)) ready.push({ device, definition: host.definition })
  }
  return ready
}

async function runtimeKey(cwd: string, domain: number) {
  return `${await ProfileStore.workspaceDir(cwd)}:runtime:${domain}`
}

/**
 * The domain's runtime, holding exactly the domain's ready devices. It starts on first use and
 * stays up between programs; one that has died, or whose world clock changed, is replaced.
 */
async function runtime(cwd: string, domain: number, signal?: AbortSignal, start = true) {
  const key = await runtimeKey(cwd, domain)
  return serialize(transitions(), key, async () => {
    const clock = await worldClock(cwd, domain)
    const fingerprint = JSON.stringify(clock ?? null)
    let host = runtimes().get(key)
    if (host && (!host.ready || host.proc.exitCode !== null || host.definition !== fingerprint)) {
      await terminate(host)
      runtimes().delete(key)
      host = undefined
    }
    if (!host) {
      if (!start) return undefined
      const launch = await pythonLaunch(cwd, "exec", undefined, signal)
      signal?.throwIfAborted()
      const proc = spawnProcess([...launch.command, "-u", "-m", "kinex.host.runtime"], { cwd, env: launch.env, group: true })
      const created: Runtime = { ...serveProcess(proc, text => created.program?.output?.(text)), definition: fingerprint, ready: true,
        pending: new Map(), devices: new Map(), clock, executable: launch.executable }
      host = created
      // A program may leave children holding output pipes open after its runtime exits.
      void proc.exit.then(() => proc.kill("SIGKILL")).catch(() => {})
      proc.stdin.write(JSON.stringify({ ros: { domain_id: domain, clock } }) + "\n")
      runtimes().set(key, host)
      void receive(host)
    }
    const ready = (await readyDevices(cwd)).filter(({ device }) => (device.runtime?.domain_id ?? 0) === domain)
    for (const name of [...host.devices.keys()].filter(name => !ready.some(({ device }) => device.name === name))) {
      await request(host, "unload", { device: name }, signal)
      host.devices.delete(name)
    }
    for (const { device, definition } of ready.filter(({ device, definition }) => host.devices.get(device.name) !== definition)) {
      await request(host, "load", { profile: { ...device, operations: resolvedOperations(device) } }, signal)
      host.devices.set(device.name, definition)
    }
    return host
  })
}

/**
 * The device has no live host: its domain's runtime, if one is up, drops the device and forgets the
 * frames its last host published. TF reaches the runtime apart from these announcements, so the
 * runtime keeps whatever arrives and learns a host's life here, before one starts and after one ends,
 * whether or not the device ever became ready.
 */
async function forget(cwd: string, device: Device, signal?: AbortSignal) {
  const key = await runtimeKey(cwd, device.runtime?.domain_id ?? 0)
  await serialize(transitions(), key, async () => {
    const host = runtimes().get(key)
    if (!host?.ready || host.proc.exitCode !== null) return
    host.devices.delete(device.name)
    // A runtime that ends before it answers has nothing left to forget.
    await request(host, "unload", { device: device.name }, signal).catch((error: unknown) => { if (host.ready) throw error })
  })
}

/** The ROS domain the ready devices share, the default without any. */
async function sharedDomain(cwd: string) {
  const domains = new Set((await readyDevices(cwd)).map(({ device }) => device.runtime?.domain_id ?? 0))
  if (domains.size > 1) throw new NamedError("RosDomainError", "one invocation requires a shared ROS domain")
  return [...domains][0] ?? 0
}

/**
 * Run a program in the runtime of the ready devices' domain, which runs one at a time: what its
 * finish returned or the error that ended it, with the interpreter that ran it. Aborting cancels
 * the program, which stops what it commanded; one that does not end in a second ends with its runtime.
 */
export async function rosExec(cwd: string, program: Message, serve: Program, signal: AbortSignal) {
  const host = await runtime(cwd, await sharedDomain(cwd), signal)
  if (!host) throw new NamedError("RosRuntimeError", "the Python runtime did not start")
  return serialize(transitions(), `${host.proc.pid}:program`, async () => {
    signal.throwIfAborted()
    const id = shortID()
    const pending = Promise.withResolvers<Message>()
    const cancel = () => {
      host.proc.stdin.write(JSON.stringify({ cancel: id }) + "\n")
      const timer = setTimeout(() => void terminate(host), 1000)
      void pending.promise.catch(() => {}).finally(() => clearTimeout(timer))
    }
    host.pending.set(id, pending)
    host.program = serve
    signal.addEventListener("abort", cancel, { once: true })
    try {
      host.proc.stdin.write(JSON.stringify({ id, action: "exec", args: program }) + "\n")
      const reply = await pending.promise.catch(async (error: unknown) => {
        // The runtime is gone. A program may end it itself, as os._exit does: its exit code is then its outcome.
        const code = await Promise.race([host.proc.exit, new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 1000))])
        if (signal.aborted || code === undefined) throw error
        return code === 0 ? { return: null, files: [] } : { error: `script exited with code ${code}` }
      })
      return { reply, executable: host.executable }
    } finally {
      signal.removeEventListener("abort", cancel)
      host.pending.delete(id)
      host.program = undefined
    }
  })
}

export async function rosReady(cwd: string, device: Device) {
  const directory = await ProfileStore.deviceDir(cwd, device.name)
  const host = hosts().get(directory)
  return !!host?.ready && host.proc.exitCode === null && host.definition === await definition(directory, device)
}

export async function rosDispatch(cwd: string, device: Device, action: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<DeviceReading> {
  const directory = await ProfileStore.deviceDir(cwd, device.name)
  const run = () => dispatch(cwd, device, action, args, signal)
  // Lifecycle actions hold the device's lane; other actions only wait for it.
  return action === "load" || action === "unload" ? serialize(transitions(), directory, run)
    : (transitions().get(directory) ?? Promise.resolve()).then(run)
}

async function dispatch(cwd: string, device: Device, action: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<DeviceReading> {
  if (action === "load") await ProfileStore.validateFrames(cwd, device.name)
  const directory = await ProfileStore.deviceDir(cwd, device.name)
  let host = hosts().get(directory)
  const domain = device.runtime?.domain_id ?? 0
  if (action === "unload") {
    if (host) {
      try { if (host.proc.exitCode === null) await request(host, "unload", {}) }
      finally { await terminate(host, true); hosts().delete(directory) }
    }
    await forget(cwd, device)
    return { deviceID: device.name, data: { unloaded: true } }
  }
  if (action === "status" && (!host || host.proc.exitCode !== null))
    return { deviceID: device.name, data: { ready: false } }
  if (action === "load") {
    const fingerprint = await definition(directory, device)
    if (host && host.definition !== fingerprint)
      throw new NamedError("RosDefinitionChanged", "unload before changing node definitions")
    if (!host || host.proc.exitCode !== null) {
      if (host) await terminate(host)
      const launch = await rosLaunch(cwd, device, signal)
      signal?.throwIfAborted()
      await forget(cwd, device, signal)
      host = { ...serveProcess(spawnProcess([...launch.command, "-u", "-m", "kinex.host.device"], {
        cwd: directory, env: launch.env, group: true,
      })), definition: fingerprint, ready: false, pending: new Map() }
      hosts().set(directory, host)
      void receive(host)
    }
    const clock = await worldClock(cwd, domain)
    try {
      await request(host, "load", { profile: { ...device, operations: resolvedOperations(device) }, clock }, signal, (device.runtime?.ready_timeout_s ?? 30) * 1000)
      host.ready = true
    } catch (error) {
      await terminate(host)
      hosts().delete(directory)
      await forget(cwd, device)
      throw error
    }
    // The device joins its domain's runtime, which programs attach to. A domain with a world clock
    // starts it now, so the first program finds it up; without one Kinex Python stays untouched until a program runs.
    await runtime(cwd, domain, signal, clock !== undefined)
    return { deviceID: device.name, data: { ready: true } }
  }
  if (!host?.ready || (action !== "stop" && host.definition !== await definition(directory, device)))
    throw new NamedError("DeviceInactiveError", `${device.name} requires explicit load or unload/validate/reload`)
  const data = await request(host, action, args, signal,
    (device.operations[action]?.timeout_s ?? 30) * 1000)
  const { file, ...fields } = data
  return { deviceID: device.name, data: fields,
    ...(typeof file === "string" ? { filePath: file } : {}) }
}

export async function rosCatalog(cwd: string) {
  const ready = (await readyDevices(cwd)).map(({ device }) => device)
  const domain_id = await sharedDomain(cwd)
  return { domain_id, clock: await worldClock(cwd, domain_id),
    catalog: Object.fromEntries(ready.flatMap(device => Object.entries(resolvedOperations(device)).map(([name, op]) => [`${device.name}.${name}`, op]))) }
}

export async function closeRos() {
  const results = await Promise.allSettled([
    ...[...hosts().values()].map(async host => {
      try { if (host.ready) await request(host, "unload", {}) }
      finally { await terminate(host, true) }
    }),
    ...[...runtimes().values()].map(host => terminate(host, true)),
  ])
  hosts().clear()
  runtimes().clear()
  const errors = results.filter(result => result.status === "rejected").map(result => result.reason)
  if (errors.length) throw new AggregateError(errors, "ROS disposal failed")
}

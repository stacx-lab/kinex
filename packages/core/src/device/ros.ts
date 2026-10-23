import { overlayCommand } from "../python/ros-environment.ts"
import path from "node:path"
import { readFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { z } from "zod"
import { scoped } from "../scope.ts"
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
interface Host extends ServeProcess {
  pending: Map<string, Pending>
  definition: string
  ready: boolean
}
const hosts = scoped(() => new Map<string, Host>())
const frameHosts = scoped(() => new Map<string, Host & { endpoint: string }>())
const enrolled = scoped(() => new Map<string, Map<string, Device>>())
const transitions = scoped(() => new Map<string, Promise<void>>())

function resolvedOperations(device: Device) {
  const endpoint = (value: string) => value.startsWith("/") ? value : path.posix.join("/", device.runtime?.namespace ?? "", value)
  return Object.fromEntries(Object.entries(device.operations).map(([name, operation]) => [name, {
    ...operation, endpoint: endpoint(operation.endpoint),
    ...(operation.motion ? { motion: {
      acquire: endpoint(operation.motion.acquire), stop: endpoint(operation.motion.stop), status: endpoint(operation.motion.status),
    } } : {}),
    ...(operation.cancellation ? { cancellation: { ...operation.cancellation, endpoint: endpoint(operation.cancellation.endpoint) } } : {}),
  }]))
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

async function receive(host: Host) {
  try {
    for (;;) {
      const line = await readLine(host.source, Date.now() + 2_147_483_647)
      if (line === undefined) throw new Error(`ROS host exited: ${host.stderr.tail}`)
      const result = z.record(z.string(), z.unknown()).parse(JSON.parse(line))
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

async function request(host: Host, action: string, args: Record<string, unknown>, owner?: string, signal?: AbortSignal, timeout = 30_000) {
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
    host.proc.stdin.write(JSON.stringify({ id, action, args, owner }) + "\n")
    await host.proc.stdin.flush()
    return await pending.promise
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", cancel)
    host.pending.delete(id)
  }
}

/** Joins the device to its domain's frame host and returns the domain's world clock, if any. */
async function frames(cwd: string, device: Device, signal?: AbortSignal) {
  const domain = device.runtime?.domain_id ?? 0
  const workspace = await ProfileStore.workspaceDir(cwd)
  const key = `${workspace}:frames:${domain}`
  const result = (transitions().get(key) ?? Promise.resolve()).then(async () => {
    const worlds = (await ProfileStore.listDevices(cwd)).filter(value => value.type === "world" && value.runtime?.domain_id === domain)
    const clocks = worlds.flatMap(world => Object.values(resolvedOperations(world)).filter(op => op.type === "rosgraph_msgs/msg/Clock" && op.direction === "output"))
    if (!clocks.length) return undefined
    if (clocks.length !== 1) throw new NamedError("RosClockError", "one world clock is required per ROS domain")
    const [clock] = clocks
    const fingerprint = JSON.stringify(clock)
    let host = frameHosts().get(key)
    if (host && (!host.ready || host.proc.exitCode !== null || host.definition !== fingerprint)) {
      await terminate(host)
      frameHosts().delete(key)
      host = undefined
    }
    if (!host) {
      const launch = await pythonLaunch(cwd, "node", undefined, signal)
      const endpoint = `/kinex/internal/f_${shortID()}/lookup_transform`
      host = { ...serveProcess(spawnProcess([...launch.command, "-u", "-m", "kinex.host.device"], {
        cwd, env: launch.env, group: true,
      })), endpoint, definition: fingerprint, ready: false, pending: new Map() }
      frameHosts().set(key, host)
      void receive(host)
      try {
        await request(host, "$frames", { clock, domain_id: domain, endpoint }, undefined, signal)
        host.ready = true
      } catch (error) {
        await terminate(host)
        frameHosts().delete(key)
        throw error
      }
    }
    await request(host, "$frame_device", { name: device.name, active: true }, undefined, signal)
    return clock
  })
  const tail = result.then(() => {}, () => {})
  transitions().set(key, tail)
  void tail.then(() => { if (transitions().get(key) === tail) transitions().delete(key) })
  return result
}

async function forgetFrames(cwd: string, device: Device) {
  const key = `${await ProfileStore.workspaceDir(cwd)}:frames:${device.runtime?.domain_id ?? 0}`
  const host = frameHosts().get(key)
  if (host?.ready && host.proc.exitCode === null)
    await request(host, "$frame_device", { name: device.name, active: false })
}

export async function rosReady(cwd: string, device: Device) {
  const directory = await ProfileStore.deviceDir(cwd, device.name)
  const host = hosts().get(directory)
  return !!host?.ready && host.proc.exitCode === null && host.definition === await definition(directory, device)
}

export async function rosDispatch(cwd: string, device: Device, action: string, args: Record<string, unknown>, owner?: string, signal?: AbortSignal): Promise<DeviceReading> {
  const directory = await ProfileStore.deviceDir(cwd, device.name)
  const before = transitions().get(directory) ?? Promise.resolve()
  const result = before.then(() => dispatch(cwd, device, action, args, owner, signal))
  if (action === "load" || action === "unload") {
    const tail = result.then(() => {}, () => {})
    transitions().set(directory, tail)
    void tail.then(() => { if (transitions().get(directory) === tail) transitions().delete(directory) })
  }
  return result
}

async function dispatch(cwd: string, device: Device, action: string, args: Record<string, unknown>, owner?: string, signal?: AbortSignal): Promise<DeviceReading> {
  if (action === "load") await ProfileStore.validateFrames(cwd, device.name)
  const directory = await ProfileStore.deviceDir(cwd, device.name)
  let host = hosts().get(directory)
  if (action === "unload") {
    if (host) {
      try { if (host.proc.exitCode === null) await request(host, "unload", {}) }
      finally { await terminate(host, true); hosts().delete(directory) }
    }
    await forgetFrames(cwd, device)
    return { deviceID: device.name, kind: device.type, data: { unloaded: true } }
  }
  if (action === "status" && (!host || host.proc.exitCode !== null))
    return { deviceID: device.name, kind: device.type, data: { ready: false } }
  if (action === "load") {
    const fingerprint = await definition(directory, device)
    if (host && host.definition !== fingerprint)
      throw new NamedError("RosDefinitionChanged", "unload before changing node definitions")
    if (!host || host.proc.exitCode !== null) {
      if (host) await terminate(host)
      const launch = await rosLaunch(cwd, device, signal)
      signal?.throwIfAborted()
      host = { ...serveProcess(spawnProcess([...launch.command, "-u", "-m", "kinex.host.device"], {
        cwd: directory, env: launch.env, group: true,
      })), definition: fingerprint, ready: false, pending: new Map() }
      hosts().set(directory, host)
      void receive(host)
    }
    try {
      const clock = await frames(cwd, device, signal)
      await request(host, "load", { profile: { ...device, operations: resolvedOperations(device) }, clock }, undefined, signal, (device.runtime?.ready_timeout_s ?? 30) * 1000)
      host.ready = true
    } catch (error) {
      await terminate(host)
      hosts().delete(directory)
      try { await forgetFrames(cwd, device) }
      catch (cleanup) { throw new AggregateError([error, cleanup], "Device load and frame cleanup failed") }
      throw error
    }
    return { deviceID: device.name, kind: device.type, data: { ready: true } }
  }
  if (!host?.ready || (action !== "$cleanup" && action !== "stop" && host.definition !== await definition(directory, device)))
    throw new NamedError("DeviceInactiveError", `${device.name} requires explicit load or unload/validate/reload`)
  const data = await request(host, action, args, owner, signal,
    (device.operations[action]?.timeout_s ?? 30) * 1000)
  const { file, ...fields } = data
  return { deviceID: device.name, kind: device.type, data: fields,
    ...(typeof file === "string" ? { filePath: file } : {}) }
}

export async function rosCatalog(cwd: string, owner?: string) {
  const devices = (await ProfileStore.listDevices(cwd)).filter(device => device.loaded && device.runtime)
  const ready = []
  for (const device of devices) if (await rosReady(cwd, device)) ready.push(device)
  const domains = new Set(ready.map(device => device.runtime?.domain_id))
  if (domains.size > 1) throw new NamedError("RosDomainError", "one invocation requires a shared ROS domain")
  const domain = ready[0]?.runtime?.domain_id ?? 0
  const frameHost = frameHosts().get(`${await ProfileStore.workspaceDir(cwd)}:frames:${domain}`)
  return { owner, domain_id: domain,
    ...(frameHost?.ready && frameHost.proc.exitCode === null ? { frames: { endpoint: frameHost.endpoint, type: "kinex_interfaces/srv/LookupTransform" } } : {}),
    catalog: Object.fromEntries(ready.flatMap(device => Object.entries(resolvedOperations(device)).map(([name, op]) => [`${device.name}.${name}`, op]))) }
}

export async function enrollRos(cwd: string, owner: string, name: string) {
  const device = await ProfileStore.readDevice(cwd, name)
  if (!device?.runtime || !await rosReady(cwd, device)) throw new NamedError("DeviceInactiveError", `${name} is not ready`)
  const key = path.join(await ProfileStore.workspaceDir(cwd), owner)
  let devices = enrolled().get(key)
  if (!devices) { devices = new Map(); enrolled().set(key, devices) }
  devices.set(name, device)
}

export async function cleanupRos(cwd: string, owner: string, failed: boolean) {
  const key = path.join(await ProfileStore.workspaceDir(cwd), owner)
  const devices = enrolled().get(key)
  if (!devices) return
  const results = await Promise.allSettled([...devices.values()].map(async device => {
    try { await rosDispatch(cwd, device, "$cleanup", { failed }, owner) }
    catch (error) { throw new NamedError("RosCleanupError", `${device.name}: ${error}`) }
  }))
  enrolled().delete(key)
  const errors = results.filter(result => result.status === "rejected").map(result => result.reason)
  if (errors.length) throw new AggregateError(errors, `ROS invocation cleanup failed: ${errors.map(String).join("; ")}`)
}

export async function closeRos() {
  const results = await Promise.allSettled([...hosts().values()].map(async host => {
    try { if (host.ready) await request(host, "unload", {}) }
    finally { await terminate(host, true) }
  }))
  hosts().clear()
  const frames = await Promise.allSettled([...frameHosts().values()].map(async host => {
    try { if (host.proc.exitCode === null) await request(host, "unload", {}) }
    finally { await terminate(host, true) }
  }))
  frameHosts().clear()
  results.push(...frames)
  const errors = results.filter(result => result.status === "rejected").map(result => result.reason)
  if (errors.length) throw new AggregateError(errors, "ROS disposal failed")
}

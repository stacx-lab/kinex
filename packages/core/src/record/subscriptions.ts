import { pythonLaunch } from "../python/launch.ts"
import fsp from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { spawnProcess } from "../util/process.ts"
import { lineSource, readLine, type LineSource } from "../util/lines.ts"
import type { ManagedProcess } from "../util/process.ts"
import { rosCatalog, rosReady } from "../device/ros.ts"
import type { Device } from "../device/profile/schema.ts"
import { streamDir, tfDir } from "./layout.ts"
import { StreamStats, type DeviceSampling } from "./schema.ts"
import { CaptureError, deadline, diagnostics, reason } from "./process.ts"

const Reply = StreamStats.partial().extend({ ready: z.boolean().optional(), done: z.boolean().optional() })
interface Entry {
  stats: StreamStats
  proc?: ManagedProcess
  lines?: LineSource
  stderr: { text: string }
  drained?: Promise<void>
  pending: Promise<void>
  closing?: Promise<void>
}
export interface Streams {
  start(device: Device, sampling: DeviceSampling): Promise<string | undefined>
  remove(name: string): Promise<void>
  stats(): Record<string, StreamStats>
  /** The capture of the domain's clock and TF, started with the first device's. */
  tf(): StreamStats | undefined
  measure(): Promise<void>
  stop(): Promise<void>
}
export async function sizeOf(target: string): Promise<number> {
  const stat = await fsp.stat(target).catch(() => undefined)
  if (!stat) return 0
  if (stat.isFile()) return stat.size
  const sizes = await Promise.all((await fsp.readdir(target)).map(name => sizeOf(path.join(target, name))))
  return sizes.reduce((sum, size) => sum + size, 0)
}

export function createStreams(input: { cwd: string; dir: string }): Streams {
  const entries = new Map<string, Entry>()
  const shared: { tf?: Entry } = {}
  function fail(entry: Entry, error: unknown) {
    entry.stats.status = "error"
    entry.stats.error = reason(error)
  }
  async function reply(entry: Entry) {
    if (!entry.lines) throw new CaptureError("recording has no control channel")
    const line = await readLine(entry.lines, Date.now() + 30_000)
    if (!line) throw new CaptureError(`recording exited: ${entry.stderr.text}`)
    const { ready, done, ...facts } = Reply.parse(JSON.parse(line))
    for (const key of ["bag", "timestamps"] as const) {
      if (facts[key]) facts[key] = path.relative(input.dir, facts[key])
    }
    if (facts.videos) facts.videos = Object.fromEntries(Object.entries(facts.videos)
      .map(([name, files]) => [name, files.map(file => path.relative(input.dir, file))]))
    Object.assign(entry.stats, facts)
    if (facts.error) throw new CaptureError(facts.error)
    return { ready, done }
  }
  function command(entry: Entry, action: "status" | "stop") {
    const result = entry.pending.then(async () => {
      if (!entry.proc || entry.proc.exitCode !== null) throw new CaptureError(`recording process unavailable: ${entry.stderr.text}`)
      entry.proc.stdin.write(JSON.stringify({ action }) + "\n")
      await entry.proc.stdin.flush()
      const result = await reply(entry)
      if (action === "stop" && !result.done) throw new CaptureError("recording did not finalize")
    })
    entry.pending = result.catch(error => fail(entry, error))
    return result
  }
  // The capture process: of a device's operations, or of the domain's clock and TF.
  async function launch(entry: Entry, config: Record<string, unknown>, domain: number) {
    const python = await pythonLaunch(input.cwd, "node")
    entry.proc = spawnProcess([...python.command, "-u", "-m", "kinex.host.recording"], {
      cwd: input.cwd, env: { ...python.env, ROS_DOMAIN_ID: String(domain) }, group: true,
    })
    entry.lines = lineSource(entry.proc.stdout)
    entry.drained = diagnostics(entry.proc.stderr, entry.stderr)
    entry.proc.stdin.write(JSON.stringify(config) + "\n")
    await entry.proc.stdin.flush()
    if (!(await reply(entry)).ready) throw new CaptureError("recording did not become ready")
  }
  async function abandon(entry: Entry, error: unknown) {
    fail(entry, error)
    // A failed startup owns only its capture process, never device nodes.
    entry.proc?.kill()
    await entry.proc?.exited
    await entry.drained
  }
  const created = (): Entry => ({ stats: StreamStats.parse({ status: "starting" }), stderr: { text: "" }, pending: Promise.resolve() })
  // Every device's observations are read against the same clock and TF, so they are recorded once.
  // Their failure is theirs alone: the devices are still captured.
  async function clockAndTf(ros: Awaited<ReturnType<typeof rosCatalog>>) {
    if (shared.tf) return
    const entry = shared.tf = created()
    await launch(entry, { ...ros, catalog: { "_world.time": ros.clock }, operations: {}, tf: true, dir: tfDir(input.dir) }, ros.domain_id)
      .catch(error => abandon(entry, error))
  }
  function remove(name: string): Promise<void> {
    const entry = entries.get(name)
    if (!entry) return Promise.resolve()
    return close(entry)
  }
  function close(entry: Entry): Promise<void> {
    entry.closing ??= (async () => {
      try {
        if (entry.proc) {
          await command(entry, "stop")
          entry.proc.stdin.end()
          await deadline(entry.proc.exited, 5_000, "recording did not exit")
          if (entry.proc.exitCode) throw new CaptureError(`recording exited ${entry.proc.exitCode}: ${entry.stderr.text}`)
        }
        if (!entry.stats.error) entry.stats.status = "stopped"
      } catch (error) { fail(entry, error) }
      finally {
        entry.proc?.kill()
        await entry.proc?.exited
        await entry.drained
      }
    })()
    return entry.closing
  }
  return {
    async start(device, sampling) {
      const entry = created()
      entries.set(device.name, entry)
      try {
        if (!device.runtime) throw new CaptureError("continuous recording requires declared ROS topics")
        if (!await rosReady(input.cwd, device)) throw new CaptureError(`${device.name} requires explicit load before recording`)
        const ros = await rosCatalog(input.cwd)
        if (!ros.clock) throw new CaptureError("recording requires a world device, whose clock times the samples")
        const names = sampling.operations.map(name => [name, `${device.name}.${name}`] as const)
        const catalog = Object.fromEntries([...names.map(([, name]) => {
          const op = ros.catalog[name]
          if (!op || op.transport !== "topic") throw new CaptureError(`${name} is not a loaded topic`)
          return [name, op] as const
        }), ["_world.time", ros.clock] as const])
        const operations = Object.fromEntries(names.map(([operation, name]) =>
          [name, { rate: sampling.rates[operation] ?? sampling.rate, format: sampling.formats[operation] ?? null }]))
        await clockAndTf(ros)
        await launch(entry, { ...ros, catalog, operations, dir: streamDir(input.dir, device.name) }, ros.domain_id)
      } catch (error) {
        await abandon(entry, error)
      }
      return entry.stats.error
    },
    remove,
    stats: () => Object.fromEntries([...entries].map(([name, entry]) => [name, entry.stats])),
    tf: () => shared.tf?.stats,
    async measure() {
      const all = [...[...entries].map(([name, entry]) => [streamDir(input.dir, name), entry] as const),
        ...(shared.tf ? [[tfDir(input.dir), shared.tf] as const] : [])]
      await Promise.all(all.map(async ([directory, entry]) => {
        if (entry.stats.status === "recording" && !entry.closing)
          await command(entry, "status").catch(error => fail(entry, error))
        entry.stats.bytes = await sizeOf(directory)
      }))
    },
    // The clock and TF outlast the devices they time.
    async stop() {
      await Promise.all([...entries.values()].map(close))
      if (shared.tf) await close(shared.tf)
    },
  }
}

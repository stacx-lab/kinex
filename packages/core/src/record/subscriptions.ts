import { pythonLaunch } from "../python/launch.ts"
import fsp from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { spawnProcess } from "../util/process.ts"
import { lineSource, readLine, type LineSource } from "../util/lines.ts"
import type { ManagedProcess } from "../util/process.ts"
import { rosCatalog, rosReady } from "../device/ros.ts"
import type { Device } from "../device/profile/schema.ts"
import { streamDir } from "./layout.ts"
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
  function remove(name: string): Promise<void> {
    const entry = entries.get(name)
    if (!entry) return Promise.resolve()
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
      const entry: Entry = { stats: StreamStats.parse({ status: "starting" }), stderr: { text: "" }, pending: Promise.resolve() }
      entries.set(device.name, entry)
      try {
        if (!device.runtime) throw new CaptureError("continuous recording requires declared ROS topics")
        if (!await rosReady(input.cwd, device)) throw new CaptureError(`${device.name} requires explicit load before recording`)
        const ros = await rosCatalog(input.cwd)
        const clocks = Object.entries(ros.catalog).filter(([, op]) => op.type === "rosgraph_msgs/msg/Clock" && op.direction === "output")
        if (clocks.length !== 1) throw new CaptureError("recording requires one loaded world clock")
        const names = sampling.operations.map(name => `${device.name}.${name}`)
        const catalog = Object.fromEntries([...names.map(name => {
          const op = ros.catalog[name]
          if (!op || op.transport !== "topic") throw new CaptureError(`${name} is not a loaded topic`)
          return [name, op] as const
        }), ...clocks])
        const launch = await pythonLaunch(input.cwd, "driver")
        entry.proc = spawnProcess([...launch.command, "-u", "-m", "kinex.ros_recording"], {
          cwd: input.cwd, env: { ...launch.env, ROS_DOMAIN_ID: String(ros.domain_id) }, group: true,
        })
        entry.lines = lineSource(entry.proc.stdout)
        entry.drained = diagnostics(entry.proc.stderr, entry.stderr)
        entry.proc.stdin.write(JSON.stringify({ ...ros, catalog, operations: names,
          dir: streamDir(input.dir, device.name), rate: sampling.rate }) + "\n")
        await entry.proc.stdin.flush()
        if (!(await reply(entry)).ready) throw new CaptureError("recording did not become ready")
      } catch (error) {
        fail(entry, error)
        // A failed startup owns only its capture process, never device nodes.
        entry.proc?.kill()
        await entry.proc?.exited
        await entry.drained
      }
      return entry.stats.error
    },
    remove,
    stats: () => Object.fromEntries([...entries].map(([name, entry]) => [name, entry.stats])),
    async measure() {
      await Promise.all([...entries].map(async ([name, entry]) => {
        if (entry.stats.status === "recording" && !entry.closing)
          await command(entry, "status").catch(error => fail(entry, error))
        entry.stats.bytes = await sizeOf(streamDir(input.dir, name))
      }))
    },
    async stop() { await Promise.all([...entries.keys()].map(remove)) },
  }
}

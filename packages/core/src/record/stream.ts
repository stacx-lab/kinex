import { preparePython } from "../python/environment.ts"
import { spawnProcess } from "../util/process.ts"
import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import type { ManagedProcess } from "../util/process.ts"
import { z } from "zod"
import type { RecordConfig } from "../config/config.ts"
import { isCameraType, type Device } from "../device/profile/schema.ts"
import { dispatchDevice } from "../device/dispatch.ts"
import type { DeviceReading } from "../device/driver.ts"
import { Assets } from "../installation/assets.ts"
import { lineSource, readLine, type LineSource } from "../util/lines.ts"
import { streamDir } from "./layout.ts"
import { StreamStats, type DeviceSampling } from "./schema.ts"
import { CaptureError, deadline, diagnostics, reason } from "./process.ts"
import type { Writer } from "./writer.ts"

const Reply = StreamStats.partial().extend({ ready: z.boolean().optional(), ack: z.boolean().optional(), done: z.boolean().optional() })
type Reply = z.infer<typeof Reply>
interface Frame { t_ns: number; image: string; depth?: string }
interface Encoder {
  proc: ManagedProcess
  lines: LineSource
  stderr: { text: string }
  drained: Promise<void>
}
interface Entry {
  device: Device
  source: DeviceSampling["source"]
  stats: StreamStats
  opening?: Promise<void>
  closing?: Promise<void>
  sending?: Promise<void>
  pending?: Frame
  encoder?: Encoder
  transportDropped: number
  driverStarted?: boolean
}

export interface Streams {
  start(device: Device, sampling: DeviceSampling): Promise<string | undefined>
  remove(name: string): Promise<void>
  feed(name: string, reading: DeviceReading, wall: number): boolean
  stats(): Record<string, StreamStats>
  measure(): Promise<void>
  stop(): Promise<void>
}

export async function sizeOf(target: string): Promise<number> {
  const stat = await fsp.stat(target).catch(() => undefined)
  if (!stat) return 0
  if (stat.isFile()) return stat.size
  const sizes = await Promise.all((await fsp.readdir(target)).map((name) => sizeOf(path.join(target, name))))
  return sizes.reduce((sum, size) => sum + size, 0)
}

export function createStreams(input: { cwd: string; dir: string; config: RecordConfig; writer: Writer }): Streams {
  const entries = new Map<string, Entry>()
  const fail = (entry: Entry, error: unknown) => {
    entry.stats.status = "error"
    entry.stats.error = `${entry.device.name}: ${reason(error)} (output: ${streamDir(input.dir, entry.device.name)})`
    entry.pending = undefined
    entry.encoder?.proc.kill()
  }
  function apply(entry: Entry, data: Reply) {
    const { ready, ack, done, ...facts } = data
    Object.assign(entry.stats, facts)
    for (const key of ["video", "depth", "state", "timestamps"] as const) {
      const file = entry.stats[key]
      if (file) entry.stats[key] = path.isAbsolute(file) ? path.relative(input.dir, file) : file
    }
    if (entry.stats.error) entry.stats.status = "error"
  }
  async function reply(encoder: Encoder, ms: number): Promise<Reply> {
    const line = await readLine(encoder.lines, Date.now() + ms)
    if (!line) {
      await deadline(encoder.drained, 1_000, "encoder closed stdout but did not close stderr")
      throw new CaptureError(`encoder closed its output: ${encoder.stderr.text}`)
    }
    return Reply.parse(JSON.parse(line))
  }
  async function open(entry: Entry, rate: number) {
    const dir = streamDir(input.dir, entry.device.name)
    await fsp.mkdir(dir, { recursive: true })
    const args = { dir, rate_hz: rate, fps: input.config.video_fps, max_px: input.config.video_max_px }
    if (entry.source === "driver") {
      entry.driverStarted = true
      const reading = await dispatchDevice(input.cwd, entry.device, "record_start", args, "stream")
      apply(entry, Reply.parse(reading.data ?? {}))
      if (!entry.stats.error) entry.stats.status = "recording"
      return
    }
    if (!isCameraType(entry.device.type)) {
      const file = path.join(dir, "state.jsonl")
      await fsp.writeFile(file, "")
      entry.stats.state = path.relative(input.dir, file)
      entry.stats.started_ns = Date.now() * 1e6
      entry.stats.status = "recording"
      return
    }
    const runtime = await preparePython(input.cwd)
    const proc = spawnProcess([runtime.executable, Assets.python("record_encode.py"), "--dir", dir, "--fps", String(args.fps), "--max-px", String(args.max_px),
      ...(entry.device.type === "rgbd" ? ["--depth"] : [])], {
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
      env: { ...runtime.env, PYTHONPATH: [Assets.python(), process.env["PYTHONPATH"]].filter(Boolean).join(path.delimiter) },
    })
    const stderr = { text: "" }
    const encoder: Encoder = { proc, lines: lineSource(proc.stdout), stderr, drained: diagnostics(proc.stderr, stderr) }
    entry.encoder = encoder
    const result = await reply(encoder, 15_000)
    if (!result.ready) throw new CaptureError(`encoder did not become ready: ${stderr.text}`)
    entry.stats.status = "recording"
  }
  async function send(entry: Entry, encoder: Encoder) {
    while (entry.pending && !entry.stats.error) {
      const frame = entry.pending
      entry.pending = undefined
      encoder.proc.stdin.write(JSON.stringify(frame) + "\n")
      await deadline(Promise.resolve(encoder.proc.stdin.flush()), 10_000, "encoder input stalled")
      const result = await reply(encoder, 10_000)
      if (!result.ack) throw new CaptureError(result.error ?? "encoder did not acknowledge frame")
      apply(entry, result)
    }
  }
  function pump(entry: Entry) {
    if (entry.sending || !entry.encoder || !entry.pending || entry.stats.error) return
    entry.sending = send(entry, entry.encoder).catch((error: unknown) => fail(entry, `encode: ${reason(error)}`)).finally(() => {
      entry.sending = undefined
      if (entry.pending) pump(entry)
    })
  }
  async function finish(entry: Entry) {
    await entry.opening
    while (entry.sending) await entry.sending
    const ended = Date.now() * 1e6
    if (entry.driverStarted) {
      const reading = await dispatchDevice(input.cwd, entry.device, "record_stop", {}, "stream")
      apply(entry, Reply.parse(reading.data ?? {}))
      entry.driverStarted = false
    }
    const encoder = entry.encoder
    if (encoder) {
      if (!entry.stats.error) {
        encoder.proc.stdin.write('{"stop":true}\n')
        encoder.proc.stdin.end()
        const result = await reply(encoder, 45_000)
        if (!result.done) throw new CaptureError("encoder did not return final facts")
        apply(entry, result)
      }
      await deadline(encoder.proc.exited, 5_000, "encoder did not exit")
      await encoder.drained
      if (encoder.proc.exitCode && !entry.stats.error) throw new CaptureError(`encoder exited ${encoder.proc.exitCode}: ${encoder.stderr.text}`)
    }
    entry.stats.transport_dropped = entry.transportDropped
    entry.stats.ended_ns ??= ended
    if (!entry.stats.error) entry.stats.status = "stopped"
  }
  function remove(name: string): Promise<void> {
    const entry = entries.get(name)
    if (!entry) return Promise.resolve()
    entry.closing ??= finish(entry).catch((error: unknown) => fail(entry, `stop: ${reason(error)}`)).finally(async () => {
      if (entry.encoder) {
        entry.encoder.proc.kill()
        await entry.encoder.proc.exited
        await entry.encoder.drained
      }
    })
    return entry.closing
  }
  return {
    async start(device, sampling) {
      const entry: Entry = { device, source: sampling.source, stats: StreamStats.parse({ status: "starting", ...(isCameraType(device.type) ? { fps: input.config.video_fps } : {}) }), transportDropped: 0 }
      entries.set(device.name, entry)
      entry.opening = open(entry, sampling.rate).catch((error: unknown) => fail(entry, `start: ${reason(error)}`))
      await entry.opening
      if (entry.stats.error) await remove(device.name)
      return entry.stats.error
    },
    remove,
    feed(name, reading, wall) {
      const entry = entries.get(name)
      if (!entry || entry.closing || entry.stats.status !== "recording") return false
      // Native capture already owns this observation. Snap still stages a copy.
      if (entry.source === "driver") return true
      if (!isCameraType(entry.device.type)) {
        if (!reading.data || !entry.stats.state) return false
        input.writer.append(path.join(input.dir, entry.stats.state), { ...reading.data, t_ns: wall * 1e6 })
        entry.stats.rows += 1
        return true
      }
      if (!entry.encoder || !reading.filePath) return false
      const scale = entry.device.type === "rgbd" && entry.device.intrinsics.depth !== "???"
        ? entry.device.intrinsics.depth.scale_m_per_unit : undefined
      if (typeof scale === "number") entry.stats.depth_scale = scale
      // Snapshot immutable per-response artifacts before handing them to the encoder.
      const frame = (() => {
        try {
          const depth = reading.data?.["depth_file"]
          return { t_ns: wall * 1e6, image: fs.readFileSync(reading.filePath).toString("base64"),
            ...(typeof depth === "string" ? { depth: fs.readFileSync(depth).toString("base64") } : {}) }
        } catch (error) {
          fail(entry, error)
          return undefined
        }
      })()
      if (!frame) return false
      if (entry.pending) entry.transportDropped += 1
      entry.stats.transport_dropped = entry.transportDropped
      entry.pending = frame
      pump(entry)
      return true
    },
    stats: () => Object.fromEntries([...entries].map(([name, entry]) => [name, entry.stats])),
    async measure() {
      await Promise.all([...entries.values()].map(async (entry) => {
        const dir = streamDir(input.dir, entry.device.name)
        entry.stats.bytes = await sizeOf(dir)
        if (entry.source === "driver" && entry.stats.status === "recording" && !entry.closing) {
          const reading = await dispatchDevice(input.cwd, entry.device, "status", {}, "stream").catch((error: unknown) => {
            fail(entry, error)
            return undefined
          })
          const facts = reading?.data?.["recording"]
          if (facts && typeof facts === "object") {
            const parsed = Reply.safeParse(facts)
            if (parsed.success) apply(entry, parsed.data)
            if (!parsed.success) fail(entry, parsed.error)
          }
        }
        if (!isCameraType(entry.device.type)) return
        for (const [key, name] of [["video", "video.mp4"], ["depth", "depth.mkv"], ["timestamps", "frames.jsonl"]] as const) {
          const file = path.join(dir, name)
          if (await sizeOf(file)) entry.stats[key] = path.relative(input.dir, file)
        }
        // Read only the first/last complete timestamp rows, independent of duration.
        const file = await fsp.open(path.join(dir, "frames.jsonl"), "r").catch(() => undefined)
        if (!file) return
        await (async () => {
          const size = (await file.stat()).size
          const head = Buffer.alloc(Math.min(1024, size))
          const tail = Buffer.alloc(Math.min(4096, size))
          await file.read(head, 0, head.length, 0)
          await file.read(tail, 0, tail.length, Math.max(0, size - tail.length))
          const Stamp = z.object({ i: z.number(), t_ns: z.number() })
          const firstLine = head.toString().split("\n")[0]
          const lastText = tail.toString()
          const lastLine = lastText.slice(0, lastText.lastIndexOf("\n")).split("\n").at(-1)
          if (firstLine && head.includes(10)) {
            const first = Stamp.parse(JSON.parse(firstLine))
            entry.stats.started_ns ??= first.t_ns
          }
          if (lastLine && lastText.includes("\n")) {
            const last = Stamp.parse(JSON.parse(lastLine))
            entry.stats.frames = Math.max(entry.stats.frames, last.i + 1)
          }
        })().finally(() => file.close()).catch((error: unknown) => fail(entry, `timestamps: ${reason(error)}`))
      }))
    },
    async stop() { await Promise.all([...entries.keys()].map(remove)) },
  }
}

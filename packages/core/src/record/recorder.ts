import { scoped } from "../scope.ts"
import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { ProfileStore } from "../device/profile/store.ts"
import { isModel, type Device } from "../device/profile/schema.ts"
import { loadConfig, recordConfig, type RecordConfig } from "../config/config.ts"
import { observeDevices, type DeviceEvent } from "../device/observe.ts"
import { dispatchDevice } from "../device/dispatch.ts"
import { streamRefusal } from "../device/interface.ts"
import { NamedError } from "../util/error.ts"
import { writeJson } from "../util/filesystem.ts"
import { Identifier } from "../util/id.ts"
import { create } from "../util/log.ts"
import { eventsFile, frameFile, listRecordings, manifestFile, recordingsDir, snapshotProfiles, timelineFile, traceFile, writeManifest } from "./layout.ts"
import type { DeviceReading } from "../device/driver.ts"
import { createSampler, type Sampler } from "./sampler.ts"
import { createStreams, sizeOf, type Streams } from "./stream.ts"
import type { DeviceEventRow, DeviceSampling, DeviceStats, RecordingManifest, TimelineRow } from "./schema.ts"
import { createWriter, stageFile, type Writer } from "./writer.ts"

const log = create("record")

export class RecordError extends NamedError {
  constructor(message: string, data: Record<string, unknown> = {}) {
    super("RecordError", message, data)
  }
}

const MAX_DATA_CHARS = 64_000
const MANIFEST_INTERVAL_MS = 1_000
const TOOL_WINDOWS = 64
// Origins the recorder itself dispatches with: their traffic is designated by construction.
const OWN_ORIGINS = new Set(["snap", "sampler", "stream"])

interface ToolWindow {
  callID: string
  name: string
  origin?: "agent"
  start: number
  end?: number
}

interface Active {
  cwd: string
  workspace: string
  dir: string
  config: RecordConfig
  manifest: RecordingManifest
  startedAt: number
  writer: Writer
  sampler: Sampler
  streams: Streams
  unobserve: () => void
  // Devices named in a stream spec or a snap list: their traffic lands under
  // devices/, everything else under passive/. A set (not the live sampling
  // map) so a deactivated device's unload row stays with its recording.
  designated: Set<string>
  seq: Map<string, number>
  manifestTimer?: ReturnType<typeof setInterval>
  persisting?: Promise<void>
  stopping?: Promise<RecordingManifest>
  reads: Set<Promise<unknown>>
  // Set by a tool-initiated stop: the trace export waits for the final
  // assistant message of the step (saved after the tool returns).
  finalMessage?: { resolve: () => void; promise: Promise<void> }
}

export type RecordingEvent = { type: "recording.changed" } | { type: "recording.warning"; message: string }
export type ExecutionEvent =
  | { type: "tool"; callID: string; name: string; status: "running" | "completed" | "error"; isError?: boolean; origin?: "agent" }
  | { type: "message"; sessionID: string; id: string; completed: boolean }
export interface RecorderHost {
  emit?(event: RecordingEvent): void
  exportTrace?(sessionID: string, range: { first?: string; last?: string }): Promise<unknown>
}
interface State {
  active?: Active
  startup?: Promise<void>
  pending: Set<Active>
  exporting: Set<Promise<void>>
  host: RecorderHost
  windows: ToolWindow[]
}
const state = scoped<State>(() => ({ windows: [], host: {}, pending: new Set(), exporting: new Set() }))

// --- attribution -----------------------------------------------------------

function attribution(wall: number): { origin: string; callID?: string } {
  const window = state().windows.findLast((entry) => entry.start <= wall && (entry.end === undefined || entry.end >= wall))
  if (!window) return { origin: "harness" }
  return { origin: window.origin ?? `tool:${window.name}`, callID: window.callID }
}

function onExecutionEvent(event: ExecutionEvent) {
  const active = state().active
  if (event.type === "tool") {
    const part = event
    if (part.status === "running") {
      state().windows.push({ callID: part.callID, name: part.name, origin: part.origin, start: Date.now() })
      if (state().windows.length > TOOL_WINDOWS) state().windows.splice(0, state().windows.length - TOOL_WINDOWS)
      if (!active) return
      timeline(active, { kind: "tool.start", callID: part.callID, name: part.name })
      return
    }
    if (part.status === "completed" || part.status === "error") {
      const window = state().windows.findLast((entry) => entry.callID === part.callID)
      if (window && window.end === undefined) window.end = Date.now()
      if (!active) return
      timeline(active, { kind: "tool.end", callID: part.callID, name: part.name, isError: part.isError ?? false })
    }
    return
  }
  if (event.type === "message") {
    for (const target of [active, ...state().pending]) {
      if (!target || event.sessionID !== target.manifest.sessionID) continue
      const range = target.manifest.messageRange
      range.first ??= event.id
      range.last = event.id
      if (event.completed) target.finalMessage?.resolve()
    }
    return
  }
}

// --- rows ------------------------------------------------------------------

function timeline(active: Active, row: Omit<TimelineRow, "t">) {
  active.writer.append(timelineFile(active.dir), { t: Date.now() - active.startedAt, ...row })
}

function deviceStats(active: Active, device: Device, passive = false): DeviceStats {
  const table = passive ? active.manifest.passive : active.manifest.devices
  const existing = table[device.name]
  if (existing) return existing
  const created = { type: device.type, events: 0, frames: 0, bytes: 0, skipped: 0, samples: 0, readErrors: 0 }
  table[device.name] = created
  return created
}

function boundedData(data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!data) return undefined
  const text = JSON.stringify(data)
  if (text.length <= MAX_DATA_CHARS) return data
  return { truncated: true, chars: text.length, keys: Object.keys(data) }
}

function stage(active: Active, device: Device, seq: number, source: string, suffix: string, passive: boolean): { rel: string; bytes: number } | undefined {
  const rel = frameFile(device.name, seq, suffix, passive)
  const bytes = (() => {
    try { return stageFile(source, path.join(active.dir, rel)) }
    catch (error) {
      active.manifest.error = `${rel}: ${error instanceof Error ? error.message : String(error)}`
      return undefined
    }
  })()
  if (bytes === undefined) return undefined
  return { rel, bytes }
}

function onDeviceEvent(event: DeviceEvent) {
  const active = state().active
  if (!active || event.workspace !== active.workspace) return
  if (event.action === "deactivate") {
    return active.sampler.remove(event.device.name).then(() => active.streams.remove(event.device.name))
  }
  const passive = !(active.designated.has(event.device.name) || OWN_ORIGINS.has(event.origin ?? ""))
  const stats = deviceStats(active, event.device, passive)
  // One counter per device name across both roots: gaps, never duplicates.
  const seq = (active.seq.get(event.device.name) ?? 0) + 1
  active.seq.set(event.device.name, seq)
  const who = attribution(event.wall)
  const row: DeviceEventRow = {
    t: event.wall - active.startedAt,
    wall: new Date(event.wall).toISOString(),
    seq,
    origin: event.origin ?? who.origin,
    ...(who.callID ? { callID: who.callID } : {}),
    action: event.action,
    args: event.args,
    latencyMs: event.latencyMs,
    ...(event.error ? { error: event.error } : {}),
  }
  const reading = event.reading
  if (reading) {
    row.data = boundedData(reading.data)
    // Scheduled samples feed continuous capture. Other reads retain their own
    // artifacts without changing the configured sampling cadence.
    const fed = event.origin === "sampler" && event.action === "read" && !event.error && !passive && active.streams.feed(event.device.name, reading, event.wall + event.latencyMs)
    if (fed) row.stream = true
    const still = !fed && event.origin !== "stream"
    if (still && reading.filePath) {
      const staged = stage(active, event.device, seq, reading.filePath, path.extname(reading.filePath) || ".bin", passive)
      if (staged) {
        row.file = staged.rel
        stats.frames += 1
        stats.bytes += staged.bytes
      }
    }
    const depth = reading.data?.["depth_file"]
    if (still && typeof depth === "string") {
      const staged = stage(active, event.device, seq, depth, ".depth.pgm", passive)
      if (staged) {
        row.depthFile = staged.rel
        stats.bytes += staged.bytes
      }
    }
  }
  stats.events += 1
  active.writer.append(eventsFile(active.dir, event.device.name, passive), row)
}

// --- manifest -------------------------------------------------------------

function syncManifest(active: Active) {
  const streams = active.streams.stats()
  const sampler = active.sampler.stats()
  for (const [name, stats] of Object.entries(active.manifest.devices)) {
    const sampled = sampler[name]
    if (sampled) {
      stats.samples = sampled.samples
      stats.readErrors = sampled.readErrors
      stats.skipped = sampled.skipped
      if (sampled.effectiveHz !== undefined) stats.effectiveHz = sampled.effectiveHz
    }
    const stream = streams[name]
    if (stream) stats.stream = stream
    if (!sampled && stream) {
      stats.samples = stream.capture_samples
      stats.skipped = stream.capture_missed
      stats.readErrors = stream.capture_errors
      stats.effectiveHz = stream.capture_hz
    }
    if (!stats.warning && (stats.skipped || stats.readErrors || stream?.transport_dropped)) {
      stats.warning = `${name}: recording shortfall; inspect missed capture slots, read errors and encoding losses. Available data is still being recorded.`
      state().host.emit?.({ type: "recording.warning", message: stats.warning })
      timeline(active, { kind: "note", text: stats.warning })
      emitChanged()
    }
  }
  active.manifest.wallMs = (active.manifest.ended ? Date.parse(active.manifest.ended) : Date.now()) - active.startedAt
}

function persistManifest(active: Active): Promise<void> {
  if (active.persisting) return active.persisting
  active.persisting = (async () => {
    await active.streams.measure()
    syncManifest(active)
    active.manifest.bytes = await sizeOf(active.dir)
    await writeManifest(active.dir, active.manifest)
  })().finally(() => { active.persisting = undefined })
  return active.persisting
}

function emitChanged() {
  state().host.emit?.({ type: "recording.changed" })
}

// Crash/exit fallback (sync-only context): leave a valid manifest behind.
function checkpoint() {
  const active = state().active
  if (!active) return
  syncManifest(active)
  active.manifest.ended = new Date().toISOString()
  active.manifest.endedBy = "exit"
  active.manifest.status = "stopped"
  fs.writeFileSync(manifestFile(active.dir), JSON.stringify(active.manifest, null, 2) + "\n")
}

// --- trace export ----------------------------------------------------------

async function exportTrace(active: Active) {
  const range = active.manifest.messageRange
  // No message crossed the bus (a standalone snap): nothing to export.
  if (range.first === undefined && range.last === undefined) return
  const trace = await state().host.exportTrace?.(active.manifest.sessionID, range)
  if (trace !== undefined) await writeJson(traceFile(active.dir), trace)
}

// --- public surface --------------------------------------------------------

// Device rates are fixed for the lifetime of a recording.
export interface DeviceSpec {
  rate: number
}

export interface StartInput {
  specs: Record<string, DeviceSpec>
  instruction?: string
  sessionID: string
}

export interface SnapInput {
  devices: string[]
  instruction?: string
  sessionID: string
}

export interface StopInput {
  outcome?: RecordingManifest["outcome"]
  summary?: string
  labels?: string[]
  endedBy?: RecordingManifest["endedBy"]
  // The stop comes from inside a tool call: the step's final assistant message
  // is saved only after the tool returns, so the trace export waits for it.
  fromTool?: boolean
}

export interface Configured {
  applied: Record<string, DeviceSampling>
  refusals: Record<string, string>
}

export interface SnapReading {
  data?: Record<string, unknown>
  file?: string
  error?: string
}

export interface SnapResult {
  recording: string
  dir: string
  // true when the snap landed inside a running stream recording.
  moment: boolean
  readings: Record<string, SnapReading>
  refusals: Record<string, string>
}

// Every device that produced events; rate/source only for configured ones.
export interface DeviceStatus extends Partial<DeviceSampling> {
  effectiveHz?: number
  skipped: number
  samples: number
  readErrors: number
  warning?: string
  encodingDropped: number
  events: number
  frames: number
  video?: string
  error?: string
  status?: string
}

export interface Status {
  id: string
  kind: RecordingManifest["kind"]
  name: string
  task?: string
  dir: string
  background: true
  elapsedS: number
  status: RecordingManifest["status"]
  devices: Record<string, DeviceStatus>
  // Traffic on devices that were never designated (tools composing by type,
  // the agent's own reads, lifecycle hooks), kept apart under passive/.
  passive: Record<string, { events: number; frames: number }>
  mb: number
  quotaHit: boolean
  moments: number
}

// A recording name from its instruction (first words, slugged) or the clock.
function nameFor(kind: RecordingManifest["kind"], instruction: string | undefined): string {
  const slug = (instruction ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, 5)
    .join("-")
  return slug || `${kind}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`
}

async function resolveDevice(active: Active, name: string): Promise<Device | string> {
  const device = await ProfileStore.readDevice(active.cwd, name)
  if (!device) return `no device "${name}" in this workspace`
  if (!device.loaded) return `device "${name}" is unloaded — activate it through the device tool or /load`
  if (device.type === "world" || isModel(device)) return `${device.type} devices have nothing to record`
  return device
}

async function configure(active: Active, specs: Record<string, DeviceSpec>): Promise<Configured> {
  const report: Configured = { applied: {}, refusals: {} }
  for (const [name, spec] of Object.entries(specs)) {
    const device = await resolveDevice(active, name)
    if (typeof device === "string") {
      report.refusals[name] = device
      continue
    }
    if (!Number.isFinite(spec.rate) || spec.rate <= 0) {
      report.refusals[name] = "rate must be positive and finite"
      continue
    }
    const source = streamRefusal(device) === undefined ? "driver" : "harness"
    const sampling = { rate: spec.rate, source } satisfies DeviceSampling
    active.designated.add(name)
    deviceStats(active, device)
    const error = await active.streams.start(device, sampling)
    if (error) {
      report.refusals[name] = error
      continue
    }
    active.manifest.sampling.devices[name] = sampling
    report.applied[name] = sampling
    if (source === "harness") active.sampler.start(device, spec.rate)
  }
  return report
}

async function open(cwd: string, kind: RecordingManifest["kind"], sessionID: string, instruction: string | undefined): Promise<Active> {
  const current = state().active
  if (current) throw new RecordError(`already recording ${current.manifest.id} ("${current.manifest.name}") — record stop first`)
  const robot = await ProfileStore.readManifest(cwd)
  if (!robot) throw new RecordError("no robot is onboarded in this project — nothing to record")
  const robotID = robot.identity.id
  const config = recordConfig(await loadConfig(cwd))
  const id = Identifier.recording()
  const dir = path.join(await recordingsDir(cwd), id)
  await fsp.mkdir(dir, { recursive: true })
  await snapshotProfiles(cwd, dir)
  const manifest: RecordingManifest = {
    id,
    kind,
    name: nameFor(kind, instruction),
    task: instruction,
    robotID,
    sessionID,
    started: new Date().toISOString(),
    status: "starting",
    sampling: { devices: {} },
    wallMs: 0,
    devices: {},
    passive: {},
    bytes: 0,
    messageRange: {},
    notes: 0,
  }
  const writer = createWriter()
  const active: Active = {
    cwd,
    workspace: await ProfileStore.workspaceDir(cwd),
    dir,
    config,
    manifest,
    startedAt: Date.parse(manifest.started),
    writer,
    sampler: createSampler({ cwd }),
    streams: createStreams({ cwd, dir, config, writer }),
    unobserve: observeDevices(onDeviceEvent),
    designated: new Set(),
    seq: new Map(),
    reads: new Set(),
  }
  active.manifestTimer = setInterval(() => {
    if (active.manifest.status !== "recording") return
    void persistManifest(active).then(async () => {
      if (state().active !== active || active.manifest.status !== "recording") return
      for (const [name, stream] of Object.entries(active.streams.stats())) {
        if (stream.status !== "error") continue
        await active.sampler.remove(name)
        await active.streams.remove(name)
      }
      if (active.manifest.error) {
        await Recorder.stop({ endedBy: "error" })
        return
      }
      if (active.manifest.bytes < active.config.max_mb * 1024 * 1024) return
      active.manifest.quotaHit = true
      await Recorder.stop({ endedBy: "quota" })
    }).catch((error: unknown) => {
      active.manifest.error = error instanceof Error ? error.message : String(error)
      void Recorder.stop({ endedBy: "error" }).catch((failure: unknown) => log.warn("recording could not be saved", { error: String(failure) }))
    })
  }, MANIFEST_INTERVAL_MS)
  state().active = active
  timeline(active, { kind: "record.start" })
  return active
}

// One read of each device now, tapped with origin "snap"; the staged frame
// path comes back so the caller can name it without touching the frame.
async function captureReads(active: Active, devices: string[], refusals: Record<string, string>): Promise<Record<string, SnapReading>> {
  const readings: Record<string, SnapReading> = {}
  await Promise.all(
    devices.map(async (name) => {
      const resolved = await resolveDevice(active, name)
      if (typeof resolved === "string") {
        refusals[name] = resolved
        return
      }
      active.designated.add(name)
      const reading: DeviceReading | string = await dispatchDevice(active.cwd, resolved, "read", {}, "snap").catch(
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      )
      if (typeof reading === "string") {
        readings[name] = { error: reading }
        return
      }
      const file = reading.filePath
        ? frameFile(name, active.seq.get(name) ?? 0, path.extname(reading.filePath) || ".bin")
        : undefined
      readings[name] = { ...(reading.data ? { data: boundedData(reading.data) } : {}), ...(file ? { file } : {}) }
    }),
  )
  return readings
}

function readAll(active: Active, devices: string[], refusals: Record<string, string>) {
  const pending = captureReads(active, devices, refusals)
  active.reads.add(pending)
  return pending.finally(() => { active.reads.delete(pending) })
}

// Reserve the singleton before any filesystem or driver await (including snaps).
async function initialize<T>(cwd: string, kind: RecordingManifest["kind"], sessionID: string, instruction: string | undefined, setup: (active: Active) => Promise<T>) {
  if (state().active || state().startup) throw new RecordError("already recording — record stop first")
  const operation = (async () => {
    const active = await open(cwd, kind, sessionID, instruction)
    return { active, result: await setup(active) }
  })()
  const startup = operation.then(() => {}, () => {})
  state().startup = startup
  return operation.catch(async (error: unknown) => {
    state().startup = undefined
    const current = state().active
    if (current) current.manifest.error = error instanceof Error ? error.message : String(error)
    await Recorder.stop({ endedBy: "error" })
    throw error
  }).finally(() => { if (state().startup === startup) state().startup = undefined })
}

export const Recorder = {
  configure(host: RecorderHost): void { state().host = host },
  observe: onExecutionEvent,
  checkpoint,
  async dispose(): Promise<void> {
    await Recorder.stop({ endedBy: "exit" })
    for (const pending of state().pending) pending.finalMessage?.resolve()
    await Promise.all([...state().exporting])
  },

  active(): boolean {
    return state().active !== undefined
  },

  async start(cwd: string, input: StartInput): Promise<{ manifest: RecordingManifest } & Configured> {
    if (!Object.keys(input.specs).length) throw new RecordError("start needs at least one device rate")
    const { active, result: report } = await initialize(cwd, "stream", input.sessionID, input.instruction, async (active) => {
      const report = await configure(active, input.specs)
      active.manifest.status = "recording"
      await persistManifest(active)
      return report
    })
    if (!Object.keys(report.applied).length) {
      active.manifest.error = Object.values(report.refusals).join("; ")
      await Recorder.stop({ endedBy: "error" })
    }
    emitChanged()
    return { manifest: active.manifest, ...report }
  },

  // `record snap arm cam <instruction>`: one read of each device now. Inside a
  // running stream recording it is a marked moment; otherwise its own
  // (already ended) recording of kind "snap".
  async snap(cwd: string, input: SnapInput): Promise<SnapResult> {
    const refusals: Record<string, string> = {}
    const running = state().active
    if (running) {
      if (running.manifest.status !== "recording") throw new RecordError("recording is starting or stopping")
      timeline(running, { kind: "note", text: input.instruction ?? `snap ${input.devices.join(", ")}` })
      running.manifest.notes += 1
      const readings = await readAll(running, input.devices, refusals)
      return { recording: running.manifest.id, dir: running.dir, moment: true, readings, refusals }
    }
    const { active, result: readings } = await initialize(cwd, "snap", input.sessionID, input.instruction,
      (active) => readAll(active, input.devices, refusals))
    await Recorder.stop({ endedBy: "stop" })
    return { recording: active.manifest.id, dir: active.dir, moment: false, readings, refusals }
  },

  // The live view, without touching disk (the prompt block, the TUI footer).
  snapshot(): Status | undefined {
    const active = state().active
    if (!active) return undefined
    syncManifest(active)
    const manifest = active.manifest
    const streams = active.streams.stats()
    const devices: Status["devices"] = {}
    for (const [name, stats] of Object.entries(manifest.devices)) {
      devices[name] = {
        ...(manifest.sampling.devices[name] ?? {}),
        ...(stats.effectiveHz !== undefined ? { effectiveHz: stats.effectiveHz } : {}),
        skipped: stats.skipped,
        samples: stats.samples,
        readErrors: stats.readErrors,
        warning: stats.warning,
        encodingDropped: streams[name]?.transport_dropped ?? 0,
        events: stats.events,
        frames: streams[name]?.frames || stats.frames,
        video: streams[name]?.video,
        error: streams[name]?.error,
        status: streams[name]?.status,
      }
    }
    const passive: Status["passive"] = {}
    for (const [name, stats] of Object.entries(manifest.passive)) passive[name] = { events: stats.events, frames: stats.frames }
    return {
      id: manifest.id,
      kind: manifest.kind,
      name: manifest.name,
      task: manifest.task,
      dir: active.dir,
      background: true,
      status: manifest.status,
      elapsedS: Math.round(manifest.wallMs / 1000),
      devices,
      passive,
      mb: Math.round((manifest.bytes / 1024 / 1024) * 10) / 10,
      quotaHit: manifest.quotaHit === true,
      moments: manifest.notes,
    }
  },

  // The same view after flushing rows and the manifest to disk, so a
  // reader accessing the files right after sees the recording as it is now.
  async status(): Promise<Status | undefined> {
    const active = state().active
    if (!active) return undefined
    await active.writer.flush()
    await persistManifest(active)
    return Recorder.snapshot()
  },

  async stop(input: StopInput = {}): Promise<RecordingManifest | undefined> {
    await state().startup
    const active = state().active
    if (!active) return undefined
    if (active.stopping) return active.stopping
    active.manifest.status = "stopping"
    clearInterval(active.manifestTimer)
    active.stopping = (async () => {
      const manifest = active.manifest
      await active.sampler.stop()
      await Promise.all([...active.reads])
      await active.streams.stop()
      active.unobserve()
      manifest.ended = new Date().toISOString()
      manifest.endedBy = input.endedBy ?? "stop"
      manifest.status = "stopped"
      if (input.outcome) manifest.outcome = input.outcome
      if (input.summary) manifest.summary = input.summary
      if (input.labels) manifest.labels = input.labels
      timeline(active, { kind: "record.stop", reason: manifest.endedBy })
      await active.writer.flush().catch((error: unknown) => {
        manifest.error = error instanceof Error ? error.message : String(error)
      })
      await active.persisting
      await persistManifest(active)
      if (!input.fromTool) await exportTrace(active)
      if (input.fromTool && state().host.exportTrace) {
        const { promise, resolve } = Promise.withResolvers<void>()
        active.finalMessage = { resolve, promise }
        state().pending.add(active)
        const timeout = setTimeout(resolve, 15_000)
        const exporting = promise.then(async () => {
          clearTimeout(timeout)
          state().pending.delete(active)
          await exportTrace(active)
          await writeManifest(active.dir, manifest)
        }).catch((error: unknown) => log.warn("trace export failed", { error: String(error) })).finally(() => { state().exporting.delete(exporting) })
        state().exporting.add(exporting)
      }
      return manifest
    })().finally(() => {
      active.unobserve()
      if (state().active === active) state().active = undefined
      emitChanged()
    })
    return active.stopping
  },

  // Recent recordings of the workspace robot, newest first, each with its directory.
  async recent(cwd: string, limit = 8): Promise<(RecordingManifest & { dir: string })[]> {
    const root = await recordingsDir(cwd)
    return (await listRecordings(cwd)).slice(0, limit).map((manifest) => ({ ...manifest, dir: path.join(root, manifest.id) }))
  },

  // Stable recording context: live counters belong in record status.
  render(): string | undefined {
    const status = Recorder.snapshot()
    if (!status) return undefined
    const devices = Object.entries(status.devices).sort(([a], [b]) => a.localeCompare(b))
      .filter(([, entry]) => entry.rate !== undefined)
      .map(([name, entry]) => `${name}@${entry.rate}Hz(${entry.source})`)
      .join(", ")
    return [
      `<recording id="${status.id}" name="${status.name}" status="${status.status}" devices="${devices || "none"}"${status.quotaHit ? ' quota="hit"' : ""}>`,
      "A background recording is running and continues across turns until `record stop`. The listed devices capture continuously at their fixed rates; every other device read/write lands under passive/. Mark decision points with `record snap <devices> <what is happening>`; `record status` flushes to disk and returns the recording directory.",
      ...Object.values(status.devices).flatMap((d) => d.warning ? [d.warning] : []).sort(),
      "</recording>",
    ].join("\n")
  },
}

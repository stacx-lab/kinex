import { z } from "zod"

// The on-disk contract of a recording (recordings/<id>/): the manifest plus
// the row shapes of the JSONL files. Downstream analysis and dataset exporters
// read these files.

// Capture configuration is fixed at start; every source records continuously.
export const DeviceSampling = z.object({
  rate: z.number().positive(),
  operations: z.array(z.string()).min(1),
})
export type DeviceSampling = z.infer<typeof DeviceSampling>

export const Sampling = z.object({ devices: z.record(z.string(), DeviceSampling).default({}) })
export type Sampling = z.infer<typeof Sampling>

export const StreamStats = z.object({
  status: z.enum(["starting", "recording", "stopped", "error"]),
  bytes: z.number().default(0),
  bag: z.string().optional(),
  operations: z.record(z.string(), z.number().nonnegative()).default({}),
  filtered: z.number().default(0),
  timestamps: z.string().optional(),
  started_ns: z.number().optional(),
  ended_ns: z.number().optional(),
  frames: z.number().default(0),
  samples: z.number().default(0),
  transport_dropped: z.number().default(0),
  error: z.string().optional(),
})
export type StreamStats = z.infer<typeof StreamStats>

export const DeviceStats = z.object({
  type: z.string(),
  events: z.number().default(0),
  frames: z.number().default(0),
  bytes: z.number().default(0),
  warning: z.string().optional(),
  stream: StreamStats.optional(),
})
export type DeviceStats = z.infer<typeof DeviceStats>

export const RecordingManifest = z.object({
  id: z.string(),
  // snap: one moment (a read of each listed device); stream: a background
  // recording that runs until stopped.
  kind: z.enum(["snap", "stream"]).default("stream"),
  name: z.string(),
  task: z.string().optional(),
  robotID: z.string(),
  sessionID: z.string(),
  started: z.string(),
  ended: z.string().optional(),
  endedBy: z.enum(["stop", "exit", "quota", "error"]).optional(),
  status: z.enum(["starting", "recording", "stopping", "stopped"]),
  error: z.string().optional(),
  outcome: z.enum(["success", "failure", "partial"]).optional(),
  summary: z.string().optional(),
  sampling: Sampling,
  wallMs: z.number().default(0),
  // Designated devices (stream rates / snap lists) live under devices/; every
  // other device the agent or a tool touched is tapped under passive/.
  devices: z.record(z.string(), DeviceStats).default({}),
  passive: z.record(z.string(), DeviceStats).default({}),
  bytes: z.number().default(0),
  quotaHit: z.boolean().optional(),
  messageRange: z.object({ first: z.string().optional(), last: z.string().optional() }).default({}),
  notes: z.number().default(0),
})
export type RecordingManifest = z.infer<typeof RecordingManifest>

// devices/<name>/events.jsonl — one row per dispatch on that device.
export const DeviceEventRow = z.object({
  t: z.number(),
  wall: z.string(),
  seq: z.number(),
  origin: z.string(),
  callID: z.string().optional(),
  action: z.string(),
  args: z.record(z.string(), z.unknown()),
  data: z.record(z.string(), z.unknown()).optional(),
  file: z.string().optional(),
  depthFile: z.string().optional(),
  latencyMs: z.number(),
  error: z.string().optional(),
})
export type DeviceEventRow = z.infer<typeof DeviceEventRow>

// timeline.jsonl — the session-side structure the trace lacks timestamps for.
export const TimelineRow = z.object({
  t: z.number(),
  kind: z.enum(["tool.start", "tool.end", "note", "record.start", "record.stop"]),
  callID: z.string().optional(),
  name: z.string().optional(),
  isError: z.boolean().optional(),
  text: z.string().optional(),
  reason: z.string().optional(),
})
export type TimelineRow = z.infer<typeof TimelineRow>

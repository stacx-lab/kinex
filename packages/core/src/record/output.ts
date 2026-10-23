import { formatJSON, omitEmptyOptional } from "../util/json.ts"
import type { RecordingManifest } from "./schema.ts"

// Optional annotations and empty bookkeeping can be omitted from presentation.
// Counts, capture state, errors and device readings keep their complete values.
const optional = ["task", "summary", "passive", "messageRange"]
const paths = [
  ...optional, "refusals",
  ...["manifest", "active", "running", "recent.*"].flatMap(prefix => optional.map(field => `${prefix}.${field}`)),
]

// A finished or running recording at a glance, for status listings.
export function recordingSummary(entry: RecordingManifest & { dir: string }) {
  return {
    id: entry.id, kind: entry.kind, name: entry.name, task: entry.task, dir: entry.dir,
    started: entry.started, ended: entry.ended, outcome: entry.outcome, status: entry.status,
    endedBy: entry.endedBy, error: entry.error, elapsedS: Math.round(entry.wallMs / 1000),
    devices: entry.devices, mb: Math.round((entry.bytes / 1024 / 1024) * 10) / 10,
  }
}

export function recordingOutput(value: unknown, verbose = true): string {
  return formatJSON(verbose ? value : omitEmptyOptional(value, paths))
}

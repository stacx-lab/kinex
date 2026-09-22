import { formatJSON, omitEmptyOptional } from "../util/json.ts"

// Optional annotations and empty bookkeeping can be omitted from presentation.
// Counts, capture state, errors and device readings keep their complete values.
const optional = ["task", "summary", "labels", "passive", "messageRange"]
const paths = [
  ...optional, "refusals",
  ...["manifest", "active", "running", "recent.*"].flatMap(prefix => optional.map(field => `${prefix}.${field}`)),
]

export function recordingOutput(value: unknown, verbose = true): string {
  return formatJSON(verbose ? value : omitEmptyOptional(value, paths))
}

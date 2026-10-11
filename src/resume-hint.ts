import { existsSync } from "node:fs"
import path from "node:path"
import { stripTerminalSequences } from "@earendil-works/pi-tui"
import type { SessionManager } from "@earendil-works/pi-coding-agent"

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** Match only the complete hint Pi 1.1.0 emits, never text inside a rendered reply. */
export function rewriteResumeHint(chunk: string, manager: SessionManager): string {
  const text = stripTerminalSequences(chunk)
  if (!/^To resume this session: pi (?:--session-dir .+ )?--session [\w-]+\n$/.test(text)) return chunk
  if (!text.endsWith(`--session ${manager.getSessionId()}\n`)) return chunk
  const file = manager.getSessionFile()
  if (!manager.isPersisted() || !file || !existsSync(file)) return chunk
  const start = chunk.indexOf("pi ")
  return `${chunk.slice(0, start)}kinex --session ${quote(path.resolve(file))}\n`
}

export function installResumeHint(getManager: () => SessionManager): () => void {
  const original = process.stdout.write
  const forward = original.bind(process.stdout)
  type Callback = (err?: Error | null) => void
  const write = (chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | Callback, callback?: Callback): boolean => {
    const output = typeof chunk === "string" ? rewriteResumeHint(chunk, getManager()) : chunk
    if (typeof encodingOrCallback === "string") return forward(output, encodingOrCallback, callback)
    return forward(output, encodingOrCallback ?? callback)
  }
  process.stdout.write = write
  return () => { if (process.stdout.write === write) process.stdout.write = original }
}

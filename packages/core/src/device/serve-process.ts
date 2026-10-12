import type { ManagedProcess } from "../util/process.ts"
import { lineSource } from "../util/lines.ts"

export interface ServeProcess {
  proc: ManagedProcess
  source: ReturnType<typeof lineSource>
  stderr: { tail: string }
  drained: Promise<void>
  stopping?: Promise<void>
}

// Drain continuously: an unread stderr pipe can block the driver's SDK calls.
// Keep only a bounded tail, including logs without newlines.
export function serveProcess(proc: ServeProcess["proc"], onOutput?: (text: string) => void): ServeProcess {
  const stderr = { tail: "" }
  const append = (text: string) => {
    stderr.tail = (stderr.tail + text).slice(-16_384)
    onOutput?.(text)
  }
  const drained = (async () => {
    const decoder = new TextDecoder()
    const reader = proc.stderr.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      append(decoder.decode(value, { stream: true }))
    }
    append(decoder.decode())
  })().catch(() => {})
  return { proc, source: lineSource(proc.stdout), stderr, drained }
}

// EOF lets the driver release its connection and recorder. Bound cleanup time,
// then force termination; replacement must await actual exit.
export function terminate(entry: ServeProcess, graceful = false): Promise<void> {
  entry.stopping ??= (async () => {
    if (graceful) entry.proc.stdin.end()
    if (!graceful) entry.proc.kill()
    const timer = graceful ? setTimeout(() => entry.proc.kill(), 5000) : undefined
    await entry.proc.exited.finally(() => {
      clearTimeout(timer)
      entry.proc.kill("SIGKILL") // also reap any surviving owned children
    })
  })()
  return entry.stopping
}

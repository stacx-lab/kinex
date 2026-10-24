import { NamedError } from "./error.ts"

// Buffered line reading over a subprocess stdout stream, shared by the ROS
// device hosts and the Python tool runner. The deadline is ABSOLUTE (epoch ms);
// callers map LineTimeoutError and EOF (undefined) onto their own typed errors.

export class LineTimeoutError extends NamedError {
  constructor() {
    super("LineTimeoutError", "timed out waiting for a line")
  }
}

export interface LineSource {
  /** The next decoded chunk; undefined once the stream ends. */
  next(): Promise<string | undefined>
  buffer: string
}

export function lineSource(stream: ReadableStream<Uint8Array>): LineSource {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  return {
    buffer: "",
    next: async () => {
      const { done, value } = await reader.read()
      return done ? undefined : decoder.decode(value, { stream: true })
    },
  }
}

// The next non-empty line, trimmed; undefined once the stream ends.
export async function readLine(source: LineSource, deadline: number): Promise<string | undefined> {
  for (;;) {
    if (Date.now() >= deadline) throw new LineTimeoutError()
    const newline = source.buffer.indexOf("\n")
    if (newline !== -1) {
      const line = source.buffer.slice(0, newline).trim()
      source.buffer = source.buffer.slice(newline + 1)
      if (line) return line
      continue
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new LineTimeoutError()
    const timer: { value?: ReturnType<typeof setTimeout> } = {}
    const chunk = await Promise.race([
      source.next(),
      new Promise<never>((_, reject) => { timer.value = setTimeout(() => reject(new LineTimeoutError()), remaining) }),
    ]).finally(() => clearTimeout(timer.value))
    if (chunk === undefined) return undefined
    source.buffer += chunk
  }
}

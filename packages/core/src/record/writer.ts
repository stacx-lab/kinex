import path from "node:path"
import fs from "node:fs"
import fsp from "node:fs/promises"

// Append-only JSONL writing that never sits on the agent loop's critical path:
// one promise chain per file (rows keep their order), awaited only by flush()
// at stop. Frame staging is the one synchronous step — a byte snapshot taken
// before the device lane releases, so later rewrites of the producer's file
// never change a recorded frame.

export interface Writer {
  append(file: string, row: Record<string, unknown>): void
  flush(): Promise<void>
}

export function createWriter(): Writer {
  const chains = new Map<string, Promise<void>>()
  const ready = new Set<string>()
  const errors: unknown[] = []
  return {
    append(file, row) {
      const line = JSON.stringify(row) + "\n"
      const previous = chains.get(file) ?? Promise.resolve()
      const next = previous
        .then(async () => {
          if (!ready.has(file)) {
            await fsp.mkdir(path.dirname(file), { recursive: true })
            ready.add(file)
          }
          await fsp.appendFile(file, line)
        })
        .catch((error: unknown) => { errors.push(error) })
      chains.set(file, next)
    },
    async flush() {
      await Promise.all([...chains.values()])
      if (errors.length) throw new AggregateError(errors, "recording files could not be written")
    },
  }
}

// Copy `src` to `dst` now (reflink where the filesystem supports it, else a
// real copy from the page cache). Returns the byte size, or undefined when
// the source is gone.
export function stageFile(src: string, dst: string): number | undefined {
  if (!fs.existsSync(src)) return undefined
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.copyFileSync(src, dst, fs.constants.COPYFILE_FICLONE)
  return fs.statSync(dst).size
}

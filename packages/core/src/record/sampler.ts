import { dispatchDevice } from "../device/dispatch.ts"
import { isCameraType, type Device } from "../device/profile/schema.ts"

export interface SamplerStats {
  skipped: number
  samples: number
  readErrors: number
  effectiveHz?: number
}

export interface Sampler {
  start(device: Device, rate: number): void
  remove(name: string): Promise<void>
  stats(): Record<string, SamplerStats>
  stop(): Promise<void>
}

// One read at a time per device. Stop/remove disable rescheduling before
// awaiting the in-flight read, so its final frame reaches the open encoder.
export function createSampler(input: { cwd: string }): Sampler {
  interface Entry {
    device: Device
    rate: number
    started: number
    ended?: number
    count: number
    next: number
    readErrors: number
    skipped: number
    timer?: ReturnType<typeof setTimeout>
    pending?: Promise<void>
    stopped: boolean
  }
  const entries = new Map<string, Entry>()
  function schedule(entry: Entry, delay: number) {
    if (entry.stopped) return
    entry.timer = setTimeout(() => { entry.pending = tick(entry) }, delay)
  }
  async function tick(entry: Entry) {
    if (entry.stopped) return
    const period = 1000 / entry.rate
    await dispatchDevice(input.cwd, entry.device, "read", isCameraType(entry.device.type) ? { output: "file" } : {}, "sampler").then(
      () => { entry.count += 1 },
      () => { entry.readErrors += 1 },
    )
    entry.next += period
    const now = performance.now()
    const missed = Math.max(0, Math.ceil((now - entry.next) / period))
    entry.skipped += missed
    entry.next += missed * period
    schedule(entry, Math.max(0, entry.next - now))
  }

  async function remove(name: string) {
    const entry = entries.get(name)
    if (!entry) return
    entry.stopped = true
    if (entry.timer) clearTimeout(entry.timer)
    await entry.pending
    entry.ended ??= performance.now()
  }
  return {
    start(device, rate) {
      const started = performance.now()
      const entry: Entry = { device, rate, started, next: started, count: 0, readErrors: 0, skipped: 0, stopped: false }
      entries.set(device.name, entry)
      schedule(entry, 0)
    },
    remove,
    stats: () => Object.fromEntries([...entries].map(([name, entry]) => [name, {
      skipped: entry.skipped,
      samples: entry.count,
      readErrors: entry.readErrors,
      effectiveHz: Math.round(entry.count * 10_000 / Math.max(1, (entry.ended ?? performance.now()) - entry.started)) / 10,
    }])),
    async stop() { await Promise.all([...entries.keys()].map(remove)) },
  }
}

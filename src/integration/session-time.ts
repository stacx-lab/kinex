import type { SessionEntry } from "@earendil-works/pi-coding-agent"

export const sessionTimeEntry = "kinex-active-time"

export function sessionTime(save: (milliseconds: number) => void, now = () => performance.now()) {
  let total = 0
  let started: number | undefined
  let running = false
  let compacting = false
  let waiting = 0
  const resume = () => {
    if ((running || compacting) && waiting === 0 && started === undefined) started = now()
  }
  const pause = () => {
    if (started === undefined) return
    const elapsed = Math.max(0, now() - started)
    total += elapsed
    started = undefined
    if (elapsed > 0) save(elapsed)
  }
  return {
    restore(entries: readonly SessionEntry[]) {
      total = 0
      started = undefined
      running = false
      compacting = false
      waiting = 0
      for (const entry of entries) {
        if (entry.type !== "custom" || entry.customType !== sessionTimeEntry) continue
        const data: unknown = entry.data
        if (data && typeof data === "object" && "milliseconds" in data && typeof data.milliseconds === "number"
          && Number.isFinite(data.milliseconds) && data.milliseconds >= 0) total += data.milliseconds
      }
    },
    start() { running = true; resume() },
    startCompaction() { compacting = true; resume() },
    endCompaction() { compacting = false; if (!running) pause() },
    pause() { waiting++; pause() },
    resume() { waiting = Math.max(0, waiting - 1); resume() },
    stop() { pause(); running = false; compacting = false; waiting = 0 },
    get active() { return started !== undefined },
    get milliseconds() { return total + (started === undefined ? 0 : Math.max(0, now() - started)) },
  }
}

export function formatElapsed(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000)
  const minutes = Math.floor(seconds / 60)
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m${String(seconds % 60).padStart(2, "0")}s`
  return minutes ? `${minutes}m${String(seconds % 60).padStart(2, "0")}s` : `${seconds}s`
}

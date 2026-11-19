// Work that outlives the call that started it. A job is any async function: a
// simulator run, a sub-agent, an API call. Starting returns at once, a lane lets a
// limited number run and queues the rest, and the caller collects with one wait.
// What it receives is a card: one line that says how the job ended and where its
// record is. Nothing here knows what a job does or which host runs it.

/** What a job says of itself when it ends; the full result belongs in its record. */
export interface Report { status?: string; summary?: string }

export interface Spec {
  id: string
  /** Jobs in one lane share its limit. */
  lane?: string
  /** Where the job leaves its full result; named on its card. */
  record?: string
  /** The work. It ends when the signal aborts. */
  run(signal: AbortSignal): Promise<Report | void>
}

export interface Card {
  id: string
  lane: string
  state: "queued" | "running" | "ended"
  /** Once ended: the job's own status, `done` by default, `error` when it threw, `stopped` when it was stopped. */
  status?: string
  summary?: string
  record?: string
}

export interface Options {
  /** How many jobs of a lane run at once; a lane not named here has no limit. */
  limits?: Record<string, number>
  /** Called once for every job that ends: where a host that tells its caller, rather than being asked, connects. */
  onEnd?(card: Card): void
}

export interface WaitOptions {
  /** Return when all have ended, or as soon as one has. */
  mode?: "all" | "any"
  timeoutS?: number
  /** Ends the wait, not the jobs. */
  signal?: AbortSignal
}

export const DEFAULT_LANE = "default"

/** A card as its caller reads it. */
export function line(card: Card): string {
  return [`${card.id} ${card.state === "ended" ? card.status : card.state}`, card.summary, card.record && `record: ${card.record}`].filter(Boolean).join(" · ")
}

interface Entry { spec: Spec; card: Card; abort: AbortController; ended: Promise<void>; end(report: Report): void }

/** The jobs of one owner: whoever creates them lists them, stops them and ends them. */
export function createJobs(options: Options = {}) {
  const entries = new Map<string, Entry>()
  const lanes = new Map<string, { running: number; queued: Entry[] }>()
  const laneOf = (name: string) => lanes.get(name) ?? lanes.set(name, { running: 0, queued: [] }).get(name)!
  const message = (error: unknown) => error instanceof Error ? error.message : String(error)

  function advance(name: string) {
    const lane = laneOf(name)
    while (lane.queued.length && lane.running < (options.limits?.[name] ?? Infinity)) {
      const entry = lane.queued.shift()!
      lane.running++
      entry.card.state = "running"
      const settle = (report: Report) => { lane.running--; entry.end(report); advance(name) }
      // A job that fails still ends: its caller is waiting for a card, not for an exception.
      void Promise.resolve().then(() => entry.spec.run(entry.abort.signal)).then(
        report => settle({ ...report, status: report?.status ?? "done" }),
        error => settle({ status: entry.abort.signal.aborted ? "stopped" : "error", summary: message(error) }))
    }
  }

  /** Starts a job and returns at once; it runs when its lane has room. */
  function start(spec: Spec): Card {
    if (entries.has(spec.id)) throw new Error(`${spec.id} was already started`)
    const lane = spec.lane ?? DEFAULT_LANE
    const card: Card = { id: spec.id, lane, state: "queued", ...(spec.record ? { record: spec.record } : {}) }
    const done = Promise.withResolvers<void>()
    const entry: Entry = { spec, card, abort: new AbortController(), ended: done.promise, end(report) {
      Object.assign(card, { state: "ended", status: report.status, ...(report.summary ? { summary: report.summary } : {}) })
      done.resolve()
      options.onEnd?.({ ...card })
    } }
    entries.set(spec.id, entry)
    laneOf(lane).queued.push(entry)
    advance(lane)
    return { ...card }
  }

  const known = (id: string) => {
    const entry = entries.get(id)
    if (!entry) throw new Error(`No job ${id}`)
    return entry
  }
  const open = () => [...entries.values()].filter(entry => entry.card.state !== "ended")

  /** Waits for the named jobs, or for every job not yet ended, and returns their cards as they then are. */
  async function wait(ids?: readonly string[], { mode = "all", timeoutS, signal }: WaitOptions = {}): Promise<Card[]> {
    const waited = ids ? ids.map(known) : open()
    const pending = waited.filter(entry => entry.card.state !== "ended").map(entry => entry.ended)
    if (pending.length && (mode === "all" || pending.length === waited.length)) {
      const stop = new AbortController()
      const timer = timeoutS === undefined ? undefined : setTimeout(() => stop.abort(), timeoutS * 1000)
      const over = AbortSignal.any([stop.signal, ...(signal ? [signal] : [])])
      const stopped = new Promise<void>(resolve => over.addEventListener("abort", () => resolve(), { once: true }))
      try { await Promise.race([mode === "all" ? Promise.all(pending) : Promise.race(pending), stopped]) }
      finally { clearTimeout(timer); stop.abort() }
      signal?.throwIfAborted()
    }
    return waited.map(entry => ({ ...entry.card }))
  }

  /** Stops one job, or all of them: a queued job ends at once, a running one when its work has let go. */
  function stop(id?: string): void {
    for (const entry of id === undefined ? open() : [known(id)]) {
      entry.abort.abort(new Error("stopped"))
      const queued = laneOf(entry.card.lane).queued
      if (!queued.includes(entry)) continue
      queued.splice(queued.indexOf(entry), 1)
      entry.end({ status: "stopped" })
    }
  }

  return {
    start, wait, stop,
    /** Every job started here, oldest first. */
    list: (): Card[] => [...entries.values()].map(entry => ({ ...entry.card })),
    get: (id: string): Card | undefined => { const entry = entries.get(id); return entry && { ...entry.card } },
  }
}
export type Jobs = ReturnType<typeof createJobs>

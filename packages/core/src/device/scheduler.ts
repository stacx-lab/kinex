import { scoped } from "../scope.ts"
import { NamedError } from "../util/error.ts"

interface Lane {
  barrier: Promise<unknown>
  writer: Promise<unknown>
  capture: Promise<unknown>
  active: Set<Promise<unknown>>
  commands: Set<AbortController>
  fault?: unknown
}
const lanes = scoped(() => new Map<string, Lane>())
const settled = (work: Promise<unknown>) => work.then(() => {}, () => {})
function lane(key: string): Lane {
  let value = lanes().get(key)
  if (!value) {
    value = { barrier: Promise.resolve(), writer: Promise.resolve(), capture: Promise.resolve(), active: new Set(), commands: new Set() }
    lanes().set(key, value)
  }
  return value
}

export interface CommandAdmission {
  check: () => void
  interrupted?: AbortSignal
}

export function scheduleDevice<T>(key: string, action: string, run: (admission: CommandAdmission) => Promise<T>, affected = [key]): Promise<T> {
  const state = lane(key)
  const mutation = !["read", "wait", "status", "fk", "ik", "record_start", "record_stop", "load", "unload", "stop"].includes(action)
  if (mutation) return scheduleWrite(state, run)
  let before = state.barrier
  if (action.startsWith("record_")) before = Promise.all([before, state.capture])
  if (action === "load" || action === "unload") before = Promise.allSettled([...state.active])
  const stopped = action === "stop" ? affected.map(lane) : []
  for (const peer of stopped)
    for (const pending of peer.commands)
      pending.abort(new NamedError("DeviceInterruptedError", "device command was interrupted by stop"))
  const result = before.then(() => run({ check() {} }))
  state.active.add(result)
  void result.finally(() => {
    state.active.delete(result)
  }).catch(() => {})
  if (action.startsWith("record_")) state.capture = settled(result)
  if (action === "load" || action === "unload") {
    state.barrier = settled(result)
    if (action === "load") void result.then(() => { state.fault = undefined }, () => {})
  }
  if (action === "stop") {
    for (const peer of stopped) {
      peer.writer = Promise.allSettled([peer.writer, result])
      void result.catch(error => { peer.fault = error })
    }
  }
  return result
}

// A new write replaces the previous command on this device.
function scheduleWrite<T>(state: Lane, run: (admission: CommandAdmission) => Promise<T>): Promise<T> {
  const command = new AbortController()
  for (const pending of state.commands)
    pending.abort(new NamedError("DeviceReplacedError", "device command was replaced"))
  state.commands.add(command)
  const check = () => {
    command.signal.throwIfAborted()
    if (state.fault) throw new NamedError("DeviceStopError", "device stop failed; reload before commanding it")
  }
  const result = Promise.all([state.barrier, state.writer]).then(async () => {
    check()
    const value = await run({ check, interrupted: command.signal })
    check()
    return value
  }).catch((error: unknown) => {
    if (error instanceof NamedError && error.data.code === "stop_failed") state.fault = error
    throw error
  })
  state.writer = settled(result)
  state.active.add(result)
  void result.finally(() => {
    state.active.delete(result)
    state.commands.delete(command)
  }).catch(() => {})
  return result
}

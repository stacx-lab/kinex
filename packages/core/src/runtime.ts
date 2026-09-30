import path from "node:path"
import { pythonEnvironment, initializePython, preparePython } from "./python/environment.ts"
import { createScope, inScope, withSignal } from "./scope.ts"
import type { CoreSettings } from "./config/config.ts"
import { ProfileStore } from "./device/profile/store.ts"
import { readinessPlan } from "./device/profile/readiness.ts"
import { roboticsContext } from "./context/index.ts"
import { closeDrivers } from "./device/driver.ts"
import { dispatchDevice, deactivateDevice } from "./device/dispatch.ts"
import { listDeviceTemplates } from "./device/templates.ts"
import { removeDevice } from "./device/remove.ts"
import { warmLoadedDevices, type Activation, loadDevice, unloadDevice, reloadDevice, pingDevice, lifecycleAction, deviceTransition } from "./device/lifecycle.ts"
import { observeDevices, type DeviceEvent } from "./device/observe.ts"
import { Recorder, type RecorderHost, type RecordingEvent, type StartInput, type SnapInput, type StopInput, type ExecutionEvent } from "./record/recorder.ts"
import { listSkills, loadSkill } from "./skill/index.ts"
import { loadTools, toModelSchema } from "./tool/registry.ts"
import { execute, type Context, type Def } from "./tool/tool.ts"
import { PermissionDeniedError, QuestionDeclinedError } from "./tool/errors.ts"

export type RuntimeEvent = RecordingEvent | { type: "device"; event: DeviceEvent } | { type: "execution"; event: ExecutionEvent }
export interface RuntimeOptions {
  directory: string
  assetsRoot?: string
  builtinSkillRoots?: readonly string[]
  reservedToolNames?: readonly string[]
  settings?: CoreSettings
  enableRecording?: boolean
  host?: Partial<Pick<Context, "ask" | "questions">> & Pick<RecorderHost, "exportTrace">
}

export interface ToolInvocation {
  sessionID: string
  callID?: string
  signal?: AbortSignal
  ask?: Context["ask"]
  questions?: Context["questions"]
}

// Construction is inert: no discovery, drivers, signal handlers or filesystem writes.
export function createKinexRuntime(options: RuntimeOptions) {
  const directory = path.resolve(options.directory)
  const scope = createScope(options)
  const abort = new AbortController()
  scope.signal = abort.signal
  const listeners = new Set<(event: RuntimeEvent) => void>()
  const operations = new Set<Promise<unknown>>()
  const state: { closing: boolean; disposed?: Promise<void>; warm?: Promise<Activation[]> } = { closing: false }
  const emit = (event: RuntimeEvent) => { for (const listener of listeners) listener(event) }
  const run = <T>(fn: () => T): T => {
    if (state.closing) throw new Error("Kinex runtime is disposed")
    return inScope(scope, fn)
  }
  const track = <T>(pending: Promise<T>): Promise<T> => {
    operations.add(pending)
    void pending.finally(() => operations.delete(pending)).catch(() => {})
    return pending
  }
  const operation = <T>(fn: () => Promise<T>) => track(run(fn))
  const observe = (event: ExecutionEvent) => {
    Recorder.observe(event)
    emit({ type: "execution", event })
  }
  const unobserve = inScope(scope, () => {
    Recorder.configure({ emit, exportTrace: options.host?.exportTrace })
    return observeDevices((event) => emit({ type: "device", event }))
  })
  const tools = () => loadTools(directory, { enableRecording: options.enableRecording, reservedToolNames: options.reservedToolNames })
  const activation = async (pending: Promise<Activation>) => {
    const value = await pending
    track(value.ready)
    return value
  }
  const scopedOperation = <T>(fn: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal) => operation(async () => {
    const combined = signal ? AbortSignal.any([abort.signal, signal]) : abort.signal
    combined.throwIfAborted()
    return withSignal(combined, () => fn(combined))
  })
  const executeTool = (def: Def, input: unknown, call: ToolInvocation) => scopedOperation(async signal => {
    const callID = call.callID ?? crypto.randomUUID()
    observe({ type: "tool", name: def.id, callID, status: "running", origin: def.recordingOrigin })
    const ctx: Context = {
      directory, sessionID: call.sessionID, abort: signal,
      ask: call.ask ?? options.host?.ask ?? (async ({ permission }) => {
        if (permission === "device_stop") return
        throw new PermissionDeniedError(permission)
      }),
      questions: call.questions ?? options.host?.questions ?? (async () => { throw new QuestionDeclinedError() }),
    }
    return execute(def, input, ctx).then((result) => {
      observe({ type: "tool", name: def.id, callID, status: result.isError ? "error" : "completed", isError: result.isError })
      return result
    }, (error: unknown) => { observe({ type: "tool", name: def.id, callID, status: "error", isError: true }); throw error })
  }, call.signal)
  return {
    directory,
    // Composition bridge for the standalone app's existing low-level consumers.
    // Extension hosts should use the bound methods below.
    run,
    operation: scopedOperation,
    subscribe(listener: (event: RuntimeEvent) => void) {
      return run(() => { listeners.add(listener); return () => { listeners.delete(listener) } })
    },
    observe: (event: ExecutionEvent) => run(() => observe(event)),
    context: () => operation(() => roboticsContext(directory, options.enableRecording)),
    python: {
      status: () => operation(() => pythonEnvironment(directory)),
      initialize: () => operation(() => initializePython(directory)),
      prepare: (input: { signal?: AbortSignal } = {}) => operation(() => preparePython(directory,
        input.signal ? AbortSignal.any([abort.signal, input.signal]) : abort.signal)),
    },
    tools: {
      list: () => operation(async () => {
        const loaded = await tools()
        return { tools: [...loaded.tools.values()].map(toModelSchema), problems: loaded.problems }
      }),
      execute: executeTool,
      call: (name: string, input: unknown, call: ToolInvocation) => scopedOperation(async signal => {
        const def = (await tools()).tools.get(name)
        if (!def) throw new Error(`unknown tool "${name}"`)
        return executeTool(def, input, { ...call, signal })
      }, call.signal),
    },
    skills: {
      list: () => operation(() => listSkills(directory)),
      load: (name: string) => operation(() => loadSkill(directory, name)),
    },
    devices: {
      warmLoaded: () => run(() => state.warm ??= operation(async () => {
        const values = await warmLoadedDevices(directory, abort.signal)
        return Promise.all(values.map(value => activation(Promise.resolve(value))))
      })),
      list: () => operation(() => ProfileStore.listDevices(directory)),
      templates: () => operation(() => listDeviceTemplates(directory)),
      unregister: (name: string, signal?: AbortSignal) => scopedOperation(abort => deviceTransition(directory, name, async () => {
        abort.throwIfAborted()
        const device = await ProfileStore.readDevice(directory, name)
        if (!device) throw new Error(`unknown device "${name}"`)
        await deactivateDevice(directory, device)
        abort.throwIfAborted()
        await removeDevice(directory, name)
      }), signal),
      load: (name: string, signal?: AbortSignal) => operation(() => activation(loadDevice(directory, name, signal ? AbortSignal.any([abort.signal, signal]) : abort.signal))),
      unload: (name: string) => operation(() => unloadDevice(directory, name)),
      reload: (name: string, signal?: AbortSignal) => operation(() => activation(reloadDevice(directory, name, signal ? AbortSignal.any([abort.signal, signal]) : abort.signal))),
      ping: (name: string) => operation(() => pingDevice(directory, name)),
      dispatch: (name: string, action: string, args: Record<string, unknown> = {}, signal?: AbortSignal) => operation(async () => {
        const device = await ProfileStore.readDevice(directory, name)
        if (!device) throw new Error(`unknown device "${name}"`)
        if (action === "load" || action === "unload") {
          if (Object.keys(args).length) throw new Error("load/unload accept no arguments")
          return lifecycleAction(directory, device, action, AbortSignal.any([abort.signal, ...(signal ? [signal] : [])]))
        }
        if (!device.loaded && action !== "status") throw new Error(`device "${name}" is not loaded`)
        return dispatchDevice(directory, device, action, args, undefined, AbortSignal.any([abort.signal, ...(signal ? [signal] : [])]))
      }),
    },
    profiles: {
      snapshot: () => operation(() => ProfileStore.snapshot(directory)),
      writeManifest: (patch: Record<string, unknown>) => operation(() => ProfileStore.writeManifest(directory, patch)),
      writeDevice: (patch: Record<string, unknown> & { name: string }) => operation(() => ProfileStore.writeDevice(directory, patch)),
    },
    readiness: () => operation(() => readinessPlan(directory)),
    recording: {
      start: (input: StartInput) => operation(() => Recorder.start(directory, input)),
      snap: (input: SnapInput) => operation(() => Recorder.snap(directory, input)),
      stop: (input?: StopInput) => operation(() => Recorder.stop(input)),
      status: () => operation(() => Recorder.status()),
      recent: (limit?: number) => operation(() => Recorder.recent(directory, limit)),
    },
    dispose(): Promise<void> {
      if (state.disposed) return state.disposed
      state.closing = true
      abort.abort(new Error("Kinex runtime disposed"))
      state.disposed = inScope(scope, async () => {
        await Promise.allSettled([...operations])
        try { await Recorder.dispose() }
        finally {
          unobserve()
          listeners.clear()
          scope.closed = true
          await closeDrivers()
          const processes = [...scope.processes]
          for (const proc of processes) proc.kill()
          await Promise.allSettled(processes.map((proc) => proc.exited))
        }
      })
      return state.disposed
    },
  }
}
export type KinexRuntime = ReturnType<typeof createKinexRuntime>

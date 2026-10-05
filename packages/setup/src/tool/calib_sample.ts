import { setTimeout as delay } from "node:timers/promises"
import { deviceJoints, known } from "@kinex/core/device/profile/schema"
import path from "node:path"
import { z } from "zod"
import { define } from "@kinex/core/tool/tool"
import { noRobot, unknownDevice, unloadedDevice, dispatchDevice } from "@kinex/core/tool/device/shared"
import { ProfileStore } from "@kinex/core/device/profile/store"
import { readJson } from "@kinex/core/util/filesystem"
import { AttemptInput, attempt, saveAttempt, archive } from "../calibration/attempt.ts"
import { serialized } from "../planning/plan.ts"
import { fail, atomicJSON } from "../planning/facts.ts"
import { formatJSON } from "@kinex/core/util/json"
import DESCRIPTION from "./calib_sample.txt"

export const CalibSampleTool = define("calib_sample", {
  description: DESCRIPTION,
  recordingOrigin: "agent",
  parameters: z.strictObject({
    deviceID: z.string().describe("device to sample, e.g. arm"),
    ...AttemptInput.shape,
    args: z.record(z.string(), z.unknown()).optional().describe("arguments for the driver action"),
    settle: z
      .object({
        velocity_threshold: z.number().nonnegative().default(0.005).describe("max |joint velocity| that counts as settled"),
        stable_reads: z.number().int().positive().default(3).describe("consecutive settled reads required"),
        timeout_s: z.number().positive().default(30),
      })
      .optional()
      .describe("wait for the device to stop moving before recording; omit to record immediately"),
    note: z.string().optional().describe("label stored with the sample, e.g. 'touch 3, rolled +45deg'"),
  }),
  execute: async (args, ctx) => {
    const robot = await ProfileStore.readManifest(ctx.directory)
    if (!robot) return noRobot()
    const device = await ProfileStore.readDevice(ctx.directory, args.deviceID)
    if (!device) return unknownDevice(args.deviceID)
    if (!device.loaded) return unloadedDevice(device)
    if (device.access?.driver)
      await ctx.ask({ permission: "device_read", description: `sample read from ${device.name} (${args.run ?? args.procedure ?? args.node})` })

    const run = await attempt(ctx.directory, args)
    if (!Object.values(run.bindings).includes(args.deviceID)) fail("Sample device must be a bound attempt participant")
    const settle = args.settle
    const count = (() => {
      if (!settle) return 0
      if (device.type === "joint" && known(device.intrinsics.feedback) && device.intrinsics.feedback.velocities) return deviceJoints(device).length
      if (device.type === "gripper" && known(device.intrinsics.feedback) && device.intrinsics.feedback.velocities) return device.intrinsics.feedback.positions.length
      if (device.type === "velocity" && known(device.intrinsics.feedback) && known(device.intrinsics.feedback.velocity_components)) return device.intrinsics.feedback.velocity_components.length
      return 0
    })()
    if (settle && !count) throw new Error("settling requires declared measured velocities")
    const timer = settle ? AbortSignal.timeout(Math.ceil(settle.timeout_s * 1000)) : undefined
    const signal = timer ? AbortSignal.any([ctx.abort, timer]) : ctx.abort
    const read = () => dispatchDevice(ctx.directory, device, "read", args.args ?? {}, undefined, signal)
    const state = { reading: await read(), settled: false, stable: 0, stamp: -Infinity }
    if (settle) for (;;) {
      ctx.abort.throwIfAborted()
      const data = state.reading.data
      const faults = z.array(z.unknown()).parse(data?.faults)
      if (faults.length) throw new Error(`cannot settle with faults: ${JSON.stringify(faults)}`)
      const velocities = z.array(z.number()).length(count).parse(data?.velocities)
      const stamp = z.number().parse(data?.sample_time_s ?? data?.received_time_s)
      if (stamp < state.stamp) throw new Error("sample clock moved backwards")
      if (stamp > state.stamp) {
        state.stable = velocities.every((v) => Math.abs(v) <= settle.velocity_threshold) ? state.stable + 1 : 0
        state.stamp = stamp
      }
      if (state.stable >= settle.stable_reads) { state.settled = true; break }
      const next = await delay(300, undefined, { signal }).then(read).catch((error: unknown) => {
        ctx.abort.throwIfAborted()
        if (timer?.aborted) return undefined
        throw error
      })
      if (!next) break
      state.reading = next
    }
    ctx.abort.throwIfAborted()
    const { reading, settled } = state

    const dir = await saveAttempt(ctx.directory, run)
    return serialized(dir, async () => {
      ctx.abort.throwIfAborted()
      const file = path.join(dir, "samples.json")
      const samples = (await readJson<unknown[]>(file)) ?? []
      const sample = {
        index: samples.length,
        recorded_at: new Date().toISOString(),
        device: device.name,
        action: "read",
        // Only claim settledness when it was actually checked.
        ...(settle ? { settled } : {}),
        ...(args.note ? { note: args.note } : {}),
        ...(reading.filePath ? { file: await archive(ctx.directory, run, reading.filePath) } : {}),
        data: reading.data ?? {},
      }
      samples.push(sample)
      ctx.abort.throwIfAborted()
      await atomicJSON(file, samples)

      // Return only the delta — the sample just taken plus the running count —
      // not the whole history: sample loops are the main context sink.
      return {
        title: `sample ${sample.index} of ${device.name} (${args.run ?? args.procedure ?? args.node})`,
        output: [
          `run: ${run.id}`,
          `recorded sample ${sample.index} → ${file} (${samples.length} total)`,
          settle && !settled ? `WARNING: settle timed out after ${settle.timeout_s}s — the device may still be moving; sample marked settled: false` : "",
          formatJSON(sample),
        ]
          .filter(Boolean)
          .join("\n"),
      }
    })
  },
})

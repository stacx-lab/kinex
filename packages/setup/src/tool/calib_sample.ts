import { sampleDevice } from "@kinex/core/device/sample"
import { setTimeout as delay } from "node:timers/promises"
import { deviceJoints, isJoint, known, type Device } from "@kinex/core/device/profile/schema"
import { linkPose } from "@kinex/core/device/device-model"
import { deviceTree, modelErrors } from "@kinex/core/device/profile/urdf"
import path from "node:path"
import { z } from "zod"
import { define } from "@kinex/core/tool/tool"
import { noRobot, unknownDevice, unloadedDevice } from "@kinex/core/tool/device/shared"
import { ProfileStore } from "@kinex/core/device/profile/store"
import { readJson } from "@kinex/core/util/filesystem"
import { AttemptInput, attempt, saveAttempt, archive } from "../calibration/attempt.ts"
import { serialized } from "../planning/plan.ts"
import { fail, atomicJSON } from "../planning/facts.ts"
import { formatJSON } from "@kinex/core/util/json"
import DESCRIPTION from "./calib_sample.txt"

type Reading = Record<string, unknown> | undefined

// A joint-state reading's values by joint name.
function measured(data: Reading, key: "positions" | "velocities") {
  const names = z.array(z.string()).parse(data?.joint_names)
  const values = z.array(z.number()).parse(data?.[key])
  if (values.length !== names.length) throw new Error(`joint state ${key} must match its joint names`)
  return Object.fromEntries(names.map((name, index) => [name, values[index]!]))
}

// Settling velocities: commanded joints of a joint device, or a velocity device's channels.
function velocityReader(device: Device): (data: Reading) => number[] {
  if (device.type === "velocity" && known(device.feedback) && known(device.feedback.velocity_components)) {
    const count = device.feedback.velocity_components.length
    return data => z.array(z.number()).length(count).parse(data?.velocities)
  }
  if (!isJoint(device)) throw new Error("settling requires measured velocities")
  const names = deviceJoints(device).map(joint => joint.name)
  return data => {
    const velocities = measured(data, "velocities")
    return names.map(name => velocities[name] ?? fail(`settling requires a measured velocity for ${name}`))
  }
}

export const CalibSampleTool = define("calib_sample", {
  description: DESCRIPTION,
  recordingOrigin: "agent",
  parameters: z.strictObject({
    deviceID: z.string().describe("device to sample, e.g. arm"),
    ...AttemptInput.shape,
    args: z.record(z.string(), z.unknown()).optional().describe("arguments for the observation operation"),
    frame: z.string().min(1).optional().describe("joint-device URDF link whose pose to compute through FK from this sample"),
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
    if (args.frame !== undefined && !(isJoint(device) && deviceTree(device)?.links.includes(args.frame)))
      fail(modelErrors.get(device) ?? `frame must name a URDF link of joint device ${device.name}`)
    const settle = args.settle && { ...args.settle, velocities: velocityReader(device) }
    if (device.runtime)
      await ctx.ask({ permission: "device_read", description: `sample read from ${device.name} (${args.run ?? args.procedure ?? args.node})` })

    const run = await attempt(ctx.directory, args)
    if (!Object.values(run.bindings).includes(args.deviceID)) fail("Sample device must be a bound attempt participant")
    const timer = settle ? AbortSignal.timeout(Math.ceil(settle.timeout_s * 1000)) : undefined
    const signal = timer ? AbortSignal.any([ctx.abort, timer]) : ctx.abort
    const read = () => sampleDevice(ctx.directory, device, args.args ?? {}, undefined, signal)
    const state = { reading: await read(), settled: false, stable: 0, stamp: -Infinity }
    if (settle) for (;;) {
      ctx.abort.throwIfAborted()
      const data = state.reading.data
      const faults = z.array(z.unknown()).parse(data?.faults)
      if (faults.length) throw new Error(`cannot settle with faults: ${JSON.stringify(faults)}`)
      const stamp = z.number().parse(data?.timestamp)
      if (stamp < state.stamp) throw new Error("sample clock moved backwards")
      if (stamp > state.stamp) {
        state.stable = settle.velocities(data).every((v) => Math.abs(v) <= settle.velocity_threshold) ? state.stable + 1 : 0
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
    const kinematics = args.frame === undefined ? undefined : {
      frame: args.frame, pose: await linkPose(ctx.directory, device, args.frame, measured(reading.data, "positions"), ctx.abort),
    }

    const dir = await saveAttempt(ctx.directory, run)
    return serialized(dir, async () => {
      ctx.abort.throwIfAborted()
      const file = path.join(dir, "samples.json")
      const samples = (await readJson<unknown[]>(file)) ?? []
      const data = { ...reading.data }
      if (data.depth_file !== undefined)
        data.depth_file = await archive(ctx.directory, run, z.string().parse(data.depth_file))
      const sample = {
        index: samples.length,
        recorded_at: new Date().toISOString(),
        device: device.name,
        action: "read",
        // Only claim settledness when it was actually checked.
        ...(settle ? { settled } : {}),
        ...(args.note ? { note: args.note } : {}),
        ...(reading.filePath ? { file: await archive(ctx.directory, run, reading.filePath) } : {}),
        data,
        ...(kinematics ? { kinematics } : {}),
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

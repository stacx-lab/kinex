import { z } from "zod"
import { isJoint, deviceJoints, known, type Device } from "./profile/schema.ts"
import type { DeviceReading } from "./driver.ts"
import { NamedError } from "../util/error.ts"

export function jointReading(device: Device, reading: DeviceReading): DeviceReading {
  if (!isJoint(device)) return reading
  const feedback = device.intrinsics.feedback
  const size = deviceJoints(device).length
  if (!known(feedback) || !size) throw new NamedError("JointReadingError", "joint model or feedback is unresolved")
  const data = z.object({
    positions: z.array(z.number()).length(size),
    velocities: feedback.velocities ? z.array(z.number()).length(size) : z.array(z.number()).length(0).default([]),
    efforts: feedback.efforts ? z.array(z.number()).length(size) : z.array(z.number()).length(0).default([]),
    faults: z.array(z.strictObject({ code: z.string() })),
    sample_time_s: z.number().nullable(), received_time_s: z.number().optional(),
  }).passthrough().superRefine((state, ctx) => {
    if (state.sample_time_s === null && state.received_time_s === undefined)
      ctx.addIssue({ code: "custom", message: "read requires an acquisition or receipt timestamp" })
  }).parse(reading.data)
  return { ...reading, data }
}

export function jointResult(device: Device, args: Record<string, unknown>, reading: DeviceReading): DeviceReading {
  const result = z.object({ elapsed_s: z.number().nonnegative(), state: z.record(z.string(), z.unknown()),
    completed_actions: z.number().int().nonnegative(),
  }).passthrough().parse(reading.data)
  const state = jointReading(device, { ...reading, data: result.state }).data
  if (z.object({ faults: z.array(z.unknown()) }).parse(state).faults.length)
    throw new NamedError("JointResultError", "joint motion reported faults")
  const offered = z.array(z.unknown()).parse(args.actions).length
  if (result.completed_actions > offered ||
    result.completed_actions < offered && (args.for_s === undefined || result.terminated_by !== "timeout"))
    throw new NamedError("JointResultError", "write returned an incomplete sequence without an error")
  if (args.for_s !== undefined && result.elapsed_s > z.number().parse(args.for_s) + 1e-8)
    throw new NamedError("JointResultError", "motion exceeded its execution budget")
  return { ...reading, data: { ...result, state } }
}

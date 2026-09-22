import { z } from "zod"
import { define } from "./tool.ts"
import { Recorder, type DeviceSpec } from "../record/recorder.ts"
import { parseSpec } from "../record/spec.ts"
import { recordingOutput } from "../record/output.ts"
import DESCRIPTION from "./record.txt"

// The agent's handle on the recorder: start | snap | stop | status. Starting
// capture and stopping ask the `record` permission; a snap asks device_read
// (it reads devices outside the device tool). Never returns frames.
export const RecordTool = define("record", {
  description: DESCRIPTION,
  parameters: z.object({
    action: z.enum(["snap", "start", "stop", "status"]),
    verbose: z.boolean().default(true).describe("keep all result fields; false omits empty optional annotations and bookkeeping"),
    devices: z
      .union([z.array(z.string()), z.record(z.string(), z.number().positive())])
      .optional()
      .describe(
        'snap: device names ["arm", "wrist_cam"]; start: device → sampling rate in Hz {"arm": 10, "scene_cam": 2}',
      ),
    instruction: z.string().optional().describe("snap: label for the moment; start: the task being attempted"),
    outcome: z.enum(["success", "failure", "partial"]).optional().describe("stop: how the task ended"),
    summary: z.string().optional().describe("stop: one-paragraph account of what happened"),
  }),
  execute: async (args, ctx) => {
    const json = (value: unknown) => recordingOutput(value, args.verbose)
    if (args.action === "snap") {
      const devices = Array.isArray(args.devices) ? args.devices : Object.keys(args.devices ?? {})
      if (devices.length === 0) return { title: "snap needs devices", output: 'list the devices to read, e.g. ["arm", "wrist_cam"]', isError: true }
      await ctx.ask({ permission: "device_read", description: `snap ${devices.join(", ")}${args.instruction ? ` — ${args.instruction}` : ""}` })
      const result = await Recorder.snap(ctx.directory, { devices, instruction: args.instruction, sessionID: ctx.sessionID })
      return { title: result.moment ? `moment marked in ${result.recording}` : `snap ${result.recording}`, output: json(result) }
    }
    if (args.action === "start") {
      const requested = Array.isArray(args.devices) ? undefined : args.devices
      if (!requested || Object.keys(requested).length === 0)
        return { title: "start needs rates", output: 'give each device a rate in Hz, e.g. {"arm": 10, "wrist_cam": 2}', isError: true }
      const specs: Record<string, DeviceSpec> = {}
      for (const [name, raw] of Object.entries(requested)) {
        const spec = parseSpec(raw)
        if (typeof spec === "string") return { title: "bad device spec", output: `${name}: ${spec}`, isError: true }
        specs[name] = spec
      }
      const summary = Object.entries(specs)
        .map(([name, spec]) => `${name}=${spec.rate}`)
        .join(" ")
      await ctx.ask({ permission: "record", description: `start background recording ${summary}${args.instruction ? ` — ${args.instruction}` : ""}` })
      const { manifest, applied, refusals } = await Recorder.start(ctx.directory, { specs, instruction: args.instruction, sessionID: ctx.sessionID })
      return {
        title: `recording ${manifest.id} ${manifest.status}`,
        isError: manifest.status === "stopped",
        output: json({ id: manifest.id, name: manifest.name, status: manifest.status, applied, refusals, note: manifest.status === "recording" ? "continues across turns until record stop" : "no device capture started" }),
      }
    }
    if (args.action === "stop") {
      const status = Recorder.snapshot()
      if (!status) return { title: "no recording", output: "no recording is running", isError: true }
      await ctx.ask({ permission: "record", description: `stop recording "${status.name}"${args.outcome ? ` as ${args.outcome}` : ""}` })
      const manifest = await Recorder.stop({ outcome: args.outcome, summary: args.summary, fromTool: true })
      return {
        title: `recording ${status.id} stopped`,
        output: json({ id: status.id, outcome: manifest?.outcome, elapsedS: (manifest?.wallMs ?? 0) / 1000, mb: (manifest?.bytes ?? 0) / 1024 / 1024, error: manifest?.error, endedBy: manifest?.endedBy, moments: status.moments, dir: status.dir, devices: manifest?.devices }),
      }
    }
    const status = await Recorder.status()
    const recent = (await Recorder.recent(ctx.directory)).map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      name: entry.name,
      task: entry.task,
      dir: entry.dir,
      started: entry.started,
      ended: entry.ended,
      outcome: entry.outcome,
      status: entry.status,
      endedBy: entry.endedBy,
      error: entry.error,
      elapsedS: Math.round(entry.wallMs / 1000),
      devices: entry.devices,
      mb: Math.round((entry.bytes / 1024 / 1024) * 10) / 10,
    }))
    return { title: status ? `recording ${status.id} running` : "no recording running", output: json({ running: status ?? null, recent }) }
  },
})

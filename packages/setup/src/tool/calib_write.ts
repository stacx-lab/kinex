import { z } from "zod"
import { define } from "@kinex/core/tool/tool"
import { ProfileStore } from "@kinex/core/device/profile/store"
import DESCRIPTION from "./calib_write.txt"
import { resolveDeviceTemplate } from "../templates.ts"

export const CalibWriteTool = define("calib_write", {
  description: DESCRIPTION,
  parameters: z.object({
    kind: z.enum(["robot", "device", "needed"]),
    replace: z.array(z.string()).default([]).describe("Supplied top-level sections to replace instead of merge; null removes optional sections"),
    data: z
      .record(z.string(), z.unknown())
      .describe(
        "partial workspace manifest patch (identity required on first write) for kind=robot, partial device patch (must include name; type on first write) for kind=device, or {item, note?} for kind=needed",
      ),
  }),
  execute: async (args, ctx) => {
    await ctx.ask({ permission: "calib_write", description: `write ${args.kind} record` })

    ctx.abort.throwIfAborted()
    if (args.kind === "needed") {
      const entry = args.data as { item?: string; note?: string }
      if (typeof entry.item !== "string" || entry.item === "")
        return { title: "invalid patch", output: "data.item (a calib_plan item id) is required", isError: true }
      const marked = await ProfileStore.markNeeded(ctx.directory, entry.item, entry.note).then(
        () => undefined,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      )
      if (marked !== undefined) return { title: "invalid item", output: `${marked}. Fix and retry.`, isError: true }
      const queue = await ProfileStore.listNeeded(ctx.directory)
      return {
        title: `needs calibration: ${entry.item}`,
        output: `marked needs_calibration on its section (${queue.length} item${queue.length === 1 ? "" : "s"} in the queue; clear a resolved marker explicitly with needs_calibration:null)`,
      }
    }

    const patch = args.data as Record<string, unknown> & { name?: string }
    if (args.kind === "device" && (typeof patch.name !== "string" || patch.name === ""))
      return { title: "invalid patch", output: "data.name is required and must be a non-empty string", isError: true }
    const attempt: { ok: string } | { error: string } = await (async () => {
      if (args.kind === "robot") {
        const manifest = await ProfileStore.writeManifest(ctx.directory, patch, args.replace)
        const identity = manifest.identity
        return {
          ok: `robot manifest ${identity.id} written (${identity.platform}, ${identity.kind}${manifest.sim ? `, sim ${manifest.sim.simulator}` : ""})`,
        }
      }
      const name = patch.name as string
      const existing = await ProfileStore.readDevice(ctx.directory, name)
      const loaded = existing?.loaded ?? false
      if ("loaded" in patch && patch.loaded !== loaded)
        return { error: "Use the device tool load/unload actions to change activation; profile edits only describe devices." }
      const device = await ProfileStore.writeDevice(ctx.directory, { ...patch, name, loaded }, args.replace)
      const dir = await ProfileStore.deviceDir(ctx.directory, device.name)
      return {
        ok: `device ${device.name} (${device.type}${device.loaded ? "" : ", unloaded"}) written at ${dir}/profile.yaml — its utility code belongs in ${dir}/`,
      }
    })().catch(async (error: unknown) => {
      if (error instanceof z.ZodError) {
        const detail = error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")
        const existing = args.kind === "device" && typeof patch.name === "string"
          ? await ProfileStore.readDevice(ctx.directory, patch.name) : undefined
        const type = typeof patch["type"] === "string" ? patch["type"] : existing?.type
        const guide = type ? await resolveDeviceTemplate(ctx.directory, "", type) : undefined
        const reference = guide ? ` Field reference: ${guide.directory}/DEVICE.md (Setup).` : " Inspect the existing profile and fix the indicated fields."
        return {
          error: `validation failed: ${detail}.${reference}`,
        }
      }
      if (error instanceof Error && /needs a non-empty|patch needs/.test(error.message)) return { error: error.message }
      throw error
    })

    if ("error" in attempt) return { title: `calib_write ${args.kind}`, output: attempt.error, isError: true }
    return { title: `calib_write ${args.kind}`, output: attempt.ok }
  },
})

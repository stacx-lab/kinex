import { z } from "zod"
import { define } from "./tool.ts"
import { ProfileStore } from "../device/profile/store.ts"
import DESCRIPTION from "./profile_write.txt"
import { resolveDeviceTemplate } from "../device/templates.ts"

export const ProfileWriteTool = define("profile_write", {
  description: DESCRIPTION,
  parameters: z.object({
    kind: z.enum(["robot", "device"]),
    replace: z.array(z.string()).default([]).describe("Supplied top-level sections to replace instead of merge; null removes optional sections"),
    data: z
      .record(z.string(), z.unknown())
      .describe(
        "partial workspace manifest for kind=robot, or partial device profile with its name for kind=device",
      ),
  }),
  execute: async (args, ctx) => {
    await ctx.ask({ permission: "profile_write", description: `write ${args.kind} record` })

    ctx.abort.throwIfAborted()
    const patch = args.data as Record<string, unknown> & { name?: string }
    if (args.kind === "device" && (typeof patch.name !== "string" || patch.name === ""))
      return { title: "invalid patch", output: "data.name is required and must be a non-empty string", isError: true }
    const attempt: { ok: string } | { error: string } = await (async () => {
      if (args.kind === "robot") {
        const manifest = await ProfileStore.writeManifest(ctx.directory, patch, args.replace)
        const identity = manifest.identity
        return {
          ok: `robot manifest ${identity.id} written (${identity.kind})`,
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
        const guide = type ? await resolveDeviceTemplate(ctx.directory, patch.name ?? "", type) : undefined
        const reference = guide ? ` Field reference: ${guide.directory}/DEVICE.md (Setup).` : " Inspect the existing profile and fix the indicated fields."
        return {
          error: `validation failed: ${detail}.${reference}`,
        }
      }
      throw error
    })

    if ("error" in attempt) return { title: `profile_write ${args.kind}`, output: attempt.error, isError: true }
    return { title: `profile_write ${args.kind}`, output: attempt.ok }
  },
})

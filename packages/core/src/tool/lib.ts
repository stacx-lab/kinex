import { z } from "zod"
import { define } from "./tool.ts"
import { LibPath, libNode } from "../lib/catalog.ts"
import { formatJSON } from "../util/json.ts"
import DESCRIPTION from "./lib.txt"

export const LibTool = define("lib", {
  description: DESCRIPTION,
  parameters: z.strictObject({
    path: LibPath.default("").describe("Dotted path of a module or function, such as images or images.camera_frame; omit for the library's modules"),
  }),
  execute: async (args, ctx) => ({ title: `lib ${args.path}`.trim(), output: formatJSON(await libNode(ctx.directory, args.path)) }),
})

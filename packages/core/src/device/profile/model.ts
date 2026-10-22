import { field } from "./common.ts"
import { z } from "zod"

const identifier = z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_-]*$/)

// Where the node places the model; remote nodes only call an external service.
export const Compute = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("cpu") }),
  z.strictObject({ kind: z.literal("cuda"), index: z.number().int().nonnegative() }),
  z.strictObject({ kind: z.literal("mps") }),
  z.strictObject({ kind: z.literal("remote") }),
])
export type Compute = z.infer<typeof Compute>

const Artifact = z.strictObject({
  name: identifier,
  path: z.string().min(1),
  source: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("local") }),
    z.strictObject({ kind: z.literal("huggingface"), repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/), revision: z.string().min(1), filename: z.string().min(1) }),
    z.strictObject({ kind: z.literal("url"), url: z.url(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  ]),
})
export const modelShape = {
  family: field(identifier),
  variant: z.string().regex(/^[\w./:@+-]+$/).nullable().default(null),
  implementation: z.strictObject({ repository: z.url(), revision: z.string().min(1) }).nullable().default(null),
  artifacts: field(z.array(Artifact).refine((items) => new Set(items.map((item) => item.name)).size === items.length, "artifact names must be unique")),
  compute: field(Compute),
}

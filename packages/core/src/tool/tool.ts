import { z } from "zod"
import { PermissionDeniedError, QuestionDeclinedError, failure, renderFailure } from "./errors.ts"
import type { Question } from "./interaction.ts"

export interface Context {
  sessionID: string
  directory: string
  abort: AbortSignal
  // Throws PermissionDeniedError when the user rejects; metadata carries renderer
  // hints (e.g. a diff) to the frontend.
  ask(input: { permission: string; description: string; metadata?: Record<string, unknown> }): Promise<void>
  // Live user interaction for the question tool; resolves with answers per question.
  questions(questions: Question[]): Promise<Record<string, string>>
}

// An image file the model should see alongside the text output. Stored by path
// (frames already live on disk); base64-encoded only when the request is built.
export interface Attachment {
  mime: string
  path: string
}

export interface Result {
  title: string
  output: string
  isError?: boolean
  metadata?: Record<string, unknown>
  attachments?: Attachment[]
}

export interface Def<Args extends z.ZodType = z.ZodType> {
  id: string
  recordingOrigin?: "agent"
  description: string
  parameters: Args
  // Raw JSON Schema sent to the model instead of z.toJSONSchema(parameters) —
  // python tools carry their schema in tool.yaml; their runner validates it.
  jsonSchema?: Record<string, unknown>
  execute(args: z.infer<Args>, ctx: Context): Promise<Result>
}

export function define<Args extends z.ZodType>(id: string, def: Omit<Def<Args>, "id">): Def<Args> {
  return { id, ...def }
}

const MAX_OUTPUT = 30_000

function truncate(output: string): string {
  if (output.length <= MAX_OUTPUT) return output
  return output.slice(0, MAX_OUTPUT) + `\n\n(output truncated: ${output.length - MAX_OUTPUT} characters dropped)`
}

// Wrap execution with schema validation and truncation. Invalid arguments become a
// model-facing error result rather than a crash, so the model can retry.
export async function execute(def: Def, input: unknown, ctx: Context): Promise<Result> {
  const parsed = def.parameters.safeParse(input)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ")
    return {
      title: "invalid arguments",
      output: `The ${def.id} tool was called with invalid arguments: ${detail}. Please rewrite the input so it satisfies the expected schema.`,
      isError: true,
    }
  }
  const result = await def.execute(parsed.data, ctx).catch((error: unknown) => {
    // A permission denial must escape to the loop: by default it ends the turn
    // instead of being fed back to the model as a retryable tool error. A
    // declined questionnaire ends the turn the same way — the user will steer
    // with their next message.
    if (error instanceof PermissionDeniedError) throw error
    if (error instanceof QuestionDeclinedError) throw error
    const fields = failure(error)
    return {
      title: "error",
      output: fields.code !== undefined || fields.details !== undefined ? renderFailure(fields)
        : error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      isError: true,
    }
  })
  return { ...result, output: truncate(result.output) }
}

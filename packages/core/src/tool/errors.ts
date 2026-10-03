import { NamedError } from "../util/error.ts"
import { formatJSON } from "../util/json.ts"

export interface Failure {
  error: string
  code?: string
  details?: unknown
}

// Preserve the driver's public failure fields, without forwarding stderr or internals.
export function failureMetadata(data: Record<string, unknown>): Omit<Failure, "error"> {
  return {
    ...(typeof data.code === "string" ? { code: data.code } : {}),
    ...(data.details !== undefined ? { details: data.details } : {}),
  }
}

export function failure(error: unknown): Failure {
  return { error: error instanceof Error ? error.message : String(error),
    ...(error instanceof NamedError ? failureMetadata(error.data) : {}) }
}

export function renderFailure(value: Failure): string {
  return value.code !== undefined || value.details !== undefined ? formatJSON(value) : value.error
}

export class PermissionDeniedError extends NamedError {
  constructor(
    permission: string,
    public feedback?: string,
  ) {
    super(
      "PermissionDeniedError",
      feedback
        ? `The user rejected permission "${permission}" with feedback: ${feedback}`
        : `The user rejected permission "${permission}". Do not retry the same action; ask the user how to proceed instead.`,
    )
  }
}

export class QuestionDeclinedError extends NamedError {
  constructor() {
    super(
      "QuestionDeclinedError",
      "The user declined to answer the questions and will follow up with instructions. Stop and wait for their next message.",
    )
  }
}

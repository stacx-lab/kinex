/** A host lends its terminal without exposing input bytes to setup or the model. */
export type TerminalResult<T> = { status: "unavailable" } | { status: "completed"; value: T }

export interface SetupHost {
  withTerminal?<T>(
    request: { message: string; signal: AbortSignal },
    action: (signal: AbortSignal) => Promise<T>,
  ): Promise<TerminalResult<T>>
}

export interface SetupOptions { host?: SetupHost }

import { randomBytes } from "node:crypto"

export function shortID(): string { return randomBytes(8).toString("hex") }

const state = { last: 0, counter: 0 }

// Monotonic, lexicographically ascending ids: <prefix>_<time base36 padded><counter base36 padded>
function ascending(prefix: string): string {
  const now = Date.now()
  state.counter = now === state.last ? state.counter + 1 : 0
  state.last = now
  const time = now.toString(36).padStart(10, "0")
  const count = state.counter.toString(36).padStart(4, "0")
  const random = Math.floor(Math.random() * 1296)
    .toString(36)
    .padStart(2, "0")
  return `${prefix}_${time}${count}${random}`
}

export const Identifier = {
  session: () => ascending("ses"),
  message: () => ascending("msg"),
  part: () => ascending("prt"),
  request: () => ascending("req"),
  recording: () => ascending("rec"),
}

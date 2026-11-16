import { z } from "zod"

// A subagent is a model the host runs for a program: it sees an instruction and the
// items shown to it, has no tools, and answers in text that the program parses.
// Core defines the exchange; which model answers, and how, belongs to the host.
export const SubagentCall = z.object({
  instruction: z.string().min(1),
  show: z.array(z.union([
    z.strictObject({ name: z.string().min(1), text: z.string() }),
    z.strictObject({ name: z.string().min(1), image: z.string().min(1) }),
  ])).max(16),
  model: z.string().min(1).nullish().describe("the host's name for a model; the configured subagent when absent"),
  thinking: z.string().min(1).nullish(),
  timeout_s: z.number().positive().max(600),
})
export type SubagentItem = { name: string } & ({ text: string } | { image: { path: string; mime: string } })
export interface SubagentRequest {
  instruction: string
  show: SubagentItem[]
  model?: string
  thinking?: string
}
export interface SubagentReply { text: string; model: string }
export type Subagent = (request: SubagentRequest, signal: AbortSignal) => Promise<SubagentReply>

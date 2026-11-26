import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { parseLine, sessionFile } from "./layout.ts"

// A worker's transcript as a model that studies it reads it, rendered from the
// session file Kinex wrote, which holds every image inline and is too large to read raw:
//   summary.md    the transcript in a page, read first
//   history.md    every turn and every tool call, input and output bounded per call
//   history.json  the same, with every call complete
//   images/       the images the calls returned
const INPUT_CHARS = 1200
const OUTPUT_CHARS = 2000
const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max)}\n…(${text.length - max} more characters; the full text is in history.json)` : text
const short = (text: string, max: number) => text.length > max ? `${text.slice(0, max)}…` : text
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim()

interface Block { type: string; text?: string; name?: string; id?: string; arguments?: unknown; data?: string; mimeType?: string }
interface Usage { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
interface Message { role: string; content?: string | Block[]; toolCallId?: string; isError?: boolean; usage?: Usage }

/** What a turn said, or one tool call with what it returned. */
interface Turn { role: string; text: string; images: string[] }
interface Call { call: number; name: string; input: unknown; output: string; error: boolean; images: string[] }
type Entry = Turn | Call
const isCall = (entry: Entry): entry is Call => "call" in entry
const input = (call: Call) => JSON.stringify(call.input ?? {})

/** What the trial's result says, for the head of the summary, and what the strategy adds there. */
export interface Facts {
  id: string
  task: string
  /** What the worker was given, before the skills it loaded: "Library: L1". */
  shipped?: string
  /** Where what the worker kept is. */
  kept?: string
  status?: string
  success?: boolean
  steps?: number
  reason?: string
  cause?: string
  wallS?: number
  error?: string
  note?: string
}

async function read(session: string, directory: string) {
  const entries: Entry[] = []
  const calls = new Map<string, Call>()
  const tokens = { input: 0, output: 0 }
  let images = 0
  for (const line of (await readFile(session, "utf8").catch(() => "")).split("\n")) {
    if (!line.trim()) continue
    const entry = parseLine(line) as { type?: string; message?: Message } | undefined
    const message = entry?.type === "message" ? entry.message : undefined
    if (!message || message.role === "system") continue
    tokens.input += (message.usage?.input ?? 0) + (message.usage?.cacheRead ?? 0) + (message.usage?.cacheWrite ?? 0)
    tokens.output += message.usage?.output ?? 0
    const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content ?? []
    // A result joins the call it answers, so a call reads as one unit however many ran at once.
    const answered = message.role === "toolResult" ? calls.get(message.toolCallId ?? "") : undefined
    if (answered && message.isError) answered.error = true
    for (const block of blocks) {
      if (block.type === "toolCall") {
        const call: Call = { call: calls.size + 1, name: block.name ?? "", input: block.arguments, output: "", error: false, images: [] }
        calls.set(block.id ?? `call ${call.call}`, call)
        entries.push(call)
      } else if (block.type === "text" && block.text?.trim()) {
        if (answered) answered.output += (answered.output ? "\n" : "") + block.text
        else entries.push({ role: message.role, text: block.text.trim(), images: [] })
      } else if (block.type === "image" && block.data) {
        const name = `images/${String(++images).padStart(3, "0")}.${block.mimeType?.split("/")[1] ?? "png"}`
        await mkdir(path.join(directory, "images"), { recursive: true })
        await writeFile(path.join(directory, name), Buffer.from(block.data, "base64"))
        if (answered) answered.images.push(name)
        else entries.push({ role: message.role, text: "", images: [name] })
      }
    }
  }
  return { entries, tokens }
}

function history(entries: Entry[]): string {
  const lines: string[] = []
  for (const entry of entries) {
    if (!isCall(entry)) {
      if (entry.text) lines.push(`## ${entry.role}\n\n${entry.text}\n`)
      for (const name of entry.images) lines.push(`![${entry.role}](${name})\n`)
      continue
    }
    lines.push(`### call ${entry.call}: ${entry.name}${entry.error ? " (error)" : ""}\n\n\`\`\`json\n${clip(input(entry), INPUT_CHARS)}\n\`\`\``)
    if (entry.output) lines.push(`\n\`\`\`\n${clip(entry.output, OUTPUT_CHARS)}\n\`\`\``)
    for (const name of entry.images) lines.push(`\n![call ${entry.call}](${name})`)
    lines.push("")
  }
  return lines.join("\n")
}

// The verdict and cost, the skills loaded, where the sub-agent ended (its last
// calls, errors marked) and what it said last: enough to decide where the
// transcript is worth reading.
function summary(facts: Facts, entries: Entry[], tokens: { input: number; output: number }): string {
  const calls = entries.filter(isCall)
  const errors = calls.filter(call => call.error)
  const words = entries.filter((entry): entry is Turn => !isCall(entry) && entry.role === "assistant" && entry.text !== "").at(-1)?.text
  const counts = new Map<string, number>()
  for (const call of calls) counts.set(call.name, (counts.get(call.name) ?? 0) + 1)
  const loaded = new Set(calls.filter(call => call.name === "skill").map(call => (call.input as { name?: unknown } | undefined)?.name).filter(name => typeof name === "string"))
  const line = (call: Call, inputChars: number, outputChars: number) =>
    `${call.call}. ${call.name}(${short(oneLine(input(call)), inputChars)})${call.error ? " → error" : ""}: ${short(oneLine(call.output), outputChars)}`
  const verdict = facts.status === "error" ? `no verdict, the trial did not run${facts.error ? ` (${facts.error})` : ""}`
    : [facts.success ? "success" : "failure", facts.status === "timeout" ? "the wall time ran out" : undefined, facts.reason === "success" ? undefined : facts.cause ? `${facts.reason} (${facts.cause})` : facts.reason,
      facts.steps === undefined ? undefined : `${facts.steps} steps`].filter(Boolean).join(", ")
  return [
    `# ${facts.id} — ${facts.task}`, "",
    `Verdict: ${verdict}. Cost: ${calls.length} tool calls, ${facts.wallS ?? "?"} s, ${tokens.input} input / ${tokens.output} output tokens.`,
    `${facts.shipped ? `${facts.shipped}. ` : ""}Skills loaded: [${[...loaded].join(", ")}].`,
    ...(facts.note ? [`Host note: ${facts.note}`] : []),
    ...(facts.kept ? [facts.kept] : []),
    "", `## Tools called (${calls.length})`, [...counts].sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name} ×${count}`).join(", ") || "none",
    "", `## Errors (${errors.length})`, ...(errors.length ? errors.slice(0, 12).map(call => line(call, 160, 200)) : ["none"]),
    "", "## Last 12 calls", ...(calls.length ? calls.slice(-12).map(call => line(call, 200, 300)) : ["none"]),
    "", "## Last words", words ? short(oneLine(words), 800) : "(none)",
    "", "The full transcript is history.md (history.json has every call complete).",
  ].join("\n") + "\n"
}

/** Writes summary.md, history.md, history.json and images/ beside the session file of a finished session. */
export async function writeTranscript(record: string, facts: Facts): Promise<void> {
  const { entries, tokens } = await read(sessionFile(record), record)
  await writeFile(path.join(record, "history.md"), history(entries))
  await writeFile(path.join(record, "history.json"), JSON.stringify(entries, null, 1) + "\n")
  await writeFile(path.join(record, "summary.md"), summary(facts, entries, tokens))
}

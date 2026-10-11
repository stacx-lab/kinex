#!/usr/bin/env node
// Measure one onboarding in a standalone session: wall-clock time, model turns,
// tool calls, token usage, profile_write failures and driver edits.
//
//   node packages/setup/script/onboarding-metrics.mjs <session.jsonl> [--from <regex>] [--until <regex>] [--json]
//
// The slice starts at the first user message matching --from (default: the
// /register and /onboarding workflow openers) and ends at the first tool result
// matching --until (default: a successful device load operation), or at the
// last assistant message when no result matches.
import { readFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"

// Retain the last opener for sessions saved before the dedicated ROS command was removed.
const DEFAULT_FROM = /^(Register a new device|Prepare only what is needed|Load the onboard-ros2 skill)/

export function parseSession(text) {
  const entries = []
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const entry = JSON.parse(trimmed)
    if (entry.type !== "session") entries.push(entry)
  }
  return entries
}

// The active branch: the parent chain of the last entry, oldest first.
export function branch(entries) {
  const byID = new Map(entries.map(entry => [entry.id, entry]))
  const chain = []
  let current = entries.at(-1)
  const seen = new Set()
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    chain.push(current)
    current = current.parentId ? byID.get(current.parentId) : undefined
  }
  return chain.reverse()
}

function text(content) {
  if (typeof content === "string") return content
  return (content ?? []).filter(part => part.type === "text").map(part => part.text).join("\n")
}

function loadsDevice(call) {
  if (call?.name === "device") return call.arguments?.action === "load"
  return call?.name === "devices" && call.arguments?.calls?.some(item => item.action === "load")
}

export function measure(entries, { from = DEFAULT_FROM, until } = {}) {
  const line = branch(entries).filter(entry => entry.type === "message")
  const start = line.findIndex(entry => entry.message.role === "user" && from.test(text(entry.message.content)))
  if (start < 0) throw new Error(`no user message matches ${from}`)
  const calls = new Map()
  let end = line.findIndex((entry, index) => {
    if (index <= start) return false
    const message = entry.message
    if (message.role === "assistant") {
      for (const part of message.content ?? []) if (part.type === "toolCall") calls.set(part.id, part)
    }
    if (message.role !== "toolResult" || message.isError) return false
    if (until) return until.test(text(message.content))
    const call = calls.get(message.toolCallId)
    return call?.name === message.toolName && loadsDevice(call)
  })
  if (end < 0) end = line.findLastIndex(entry => entry.message.role === "assistant")
  if (end <= start) throw new Error("the slice contains no assistant message")
  const slice = line.slice(start, end + 1)
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const toolCalls = {}
  const filesWritten = new Set()
  let modelTurns = 0, profileWriteFailures = 0, driverEdits = 0
  for (const entry of slice) {
    const message = entry.message
    if (message.role === "assistant") {
      modelTurns += 1
      for (const key of Object.keys(tokens)) tokens[key] += message.usage?.[key] ?? 0
      for (const part of message.content ?? []) {
        if (part.type !== "toolCall") continue
        toolCalls[part.name] = (toolCalls[part.name] ?? 0) + 1
        const target = typeof part.arguments?.path === "string" ? part.arguments.path
          : typeof part.arguments?.file_path === "string" ? part.arguments.file_path : undefined
        if (target && /^(write|edit)$/i.test(part.name)) {
          if (/\.kinex[\\/]devices[\\/]/.test(target)) filesWritten.add(target)
          if (/devices[\\/][^\\/]+[\\/]driver\.py$/.test(target)) driverEdits += 1
        }
      }
    }
    if (message.role === "toolResult" && message.toolName === "profile_write" && message.isError) profileWriteFailures += 1
  }
  const started = Date.parse(slice[0].timestamp), finished = Date.parse(slice.at(-1).timestamp)
  return {
    wall_clock_s: Math.round((finished - started) / 1000),
    model_turns: modelTurns,
    tool_calls: Object.fromEntries(Object.entries(toolCalls).sort()),
    tokens,
    profile_write_failures: profileWriteFailures,
    driver_edits: driverEdits,
    files_written: [...filesWritten].sort(),
  }
}

export function markdownRow(label, result) {
  const calls = Object.values(result.tool_calls).reduce((sum, count) => sum + count, 0)
  return `| ${label} | ${result.wall_clock_s} | ${result.model_turns} | ${calls} | ${result.tokens.input} | ${result.tokens.output} | ${result.tokens.cacheRead} | ${result.tokens.cacheWrite} | ${result.profile_write_failures} | ${result.driver_edits} |`
}

async function main(argv) {
  const [file, ...rest] = argv
  if (!file) {
    console.error("usage: onboarding-metrics.mjs <session.jsonl> [--from <regex>] [--until <regex>] [--json]")
    return 2
  }
  const options = {}
  let json = false
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === "--json") json = true
    else if (rest[index] === "--from") options.from = new RegExp(rest[++index] ?? "")
    else if (rest[index] === "--until") options.until = new RegExp(rest[++index] ?? "")
    else throw new Error(`unknown argument: ${rest[index]}`)
  }
  const result = measure(parseSession(await readFile(file, "utf8")), options)
  if (json) console.log(JSON.stringify(result, null, 2))
  else {
    console.log("| run | wall-clock s | model turns | tool calls | input | output | cache read | cache write | profile_write failures | driver edits |")
    console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    console.log(markdownRow(file, result))
  }
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await main(process.argv.slice(2))

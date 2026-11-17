import { highlightCode, keyHint, truncateToVisualLines, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent"
import { Box, Container, Image, Spacer, Text, TruncatedText, getCapabilities, stripTerminalSequences, truncateToWidth, type Component } from "@earendil-works/pi-tui"
import { formatJSON } from "@kinex/core/util/json"

const string = (value: unknown) => typeof value === "string" ? value : ""
const clean = (value: string) => stripTerminalSequences(value).replace(/\r/g, "")
const singleLine = (value: string) => clean(value).replace(/[\n\t]/g, " ").trim()
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {}

// A call's subject, then the rest of its input and the note its caller attached.
function summary(name: string, args: Record<string, unknown>): string[] {
  if (name === "exec") {
    // A program's arguments read as the user would type them after /exec.
    const given = [...(Array.isArray(args.argv) ? args.argv.map(string) : []), ...Object.entries(object(args.args)).map(([key, value]) => `${key}=${JSON.stringify(value)}`)]
    return [string(args.file), given.join(" "), string(args.description)]
  }
  if (name === "question") return [Array.isArray(args.questions) ? args.questions.map(question => string(object(question).header)).filter(Boolean).join(", ") : ""]
  if (name === "lib") return [string(args.path)]
  if (name === "device") return [`${string(args.action) || "read"} ${string(args.deviceID)}`]
  if (name === "devices") return [`${Array.isArray(args.calls) ? args.calls.length : 0} calls`]
  if (name === "device_stop") return [string(args.deviceID) || "all"]
  if (name === "record") {
    const devices = Array.isArray(args.devices) ? args.devices.map(string).join(", ")
      : Object.entries(object(args.devices)).map(([device, rate]) => `${device}=${typeof rate === "number" ? rate : "?"}Hz`).join(" ")
    return [[string(args.action), devices, string(args.outcome)].filter(Boolean).join(" ")]
  }
  return []
}

// A row's first line: its name, its subject like Pi's tool paths, the rest of its input, and its note in italics.
function heading(name: string, [subject = "", rest = "", note = ""]: string[], theme: Theme, expanded: boolean): Component {
  const styles: [string, (text: string) => string][] = [
    [name, text => theme.fg("toolTitle", theme.bold(text))], [subject, text => theme.fg("accent", text)],
    [rest, text => theme.fg("muted", text)], [note, text => theme.fg("muted", theme.italic(text))],
  ]
  const line = styles.flatMap(([text, style]) => singleLine(text) ? [style(singleLine(text))] : []).join(" ")
  return expanded ? new Text(line, 0, 0) : new TruncatedText(line, 0, 0)
}

const timeFields = new Set(["time_s", "used_s", "waited_s", "max_s"])
const rounded = (key: string, value: unknown) => typeof value === "number" && timeFields.has(key) ? Number(value.toFixed(6)) : value
function parse(text: string): unknown {
  try { return JSON.parse(text, rounded) }
  catch { return undefined }
}

// JSON reads like the code around it. Highlighting a very large value would stall the row.
const json = (text: string, theme: Theme) => text.length > 50_000 ? theme.fg("toolOutput", text) : highlightCode(text, "json").join("\n")
// A collapsed row shows six significant digits, and never less than a large number's integer part.
const brief = (value: unknown): unknown => value === undefined ? undefined : JSON.parse(JSON.stringify(value), (_key, item: unknown) =>
  typeof item === "number" && !Number.isInteger(item) ? Number(Math.abs(item) < 1e6 ? item.toPrecision(6) : item.toFixed(3)) : item)

// Collapsed rows keep a bounded number of visual lines, like Pi's own tool rows.
function preview(text: string, theme: Theme, maxLines: number, keep: "start" | "end"): Component {
  let cached: { width: number, lines: string[] } | undefined
  return {
    invalidate: () => { cached = undefined },
    render(width) {
      if (cached?.width === width) return cached.lines
      // The hint would take the row of a single hidden line, so show that line instead.
      const whole = truncateToVisualLines(text, maxLines + 1, width, 0, keep)
      const { visualLines, skippedCount } = whole.skippedCount ? truncateToVisualLines(text, maxLines, width, 0, keep) : whole
      // The action comes first so narrow rows keep it.
      const hint = truncateToWidth(`${theme.fg("muted", "…")} ${keyHint("app.tools.expand", "to expand")} ${theme.fg("muted", `(${skippedCount} more line${skippedCount === 1 ? "" : "s"})`)}`, width)
      const lines = !skippedCount ? visualLines : keep === "start" ? [...visualLines, hint] : [hint, ...visualLines]
      cached = { width, lines }
      return lines
    },
  }
}

function stack(...children: Component[]): Container {
  const container = new Container()
  for (const child of children) container.addChild(child)
  return container
}

// Under the title: an exec's inline source, or any other call's arguments once expanded.
function callBody(name: string, args: Record<string, unknown>, theme: Theme, expanded: boolean): Component[] {
  if (name !== "exec") return expanded && Object.keys(args).length ? [new Text(json(formatJSON(args), theme), 0, 0)] : []
  if (!string(args.python)) return []
  const code = highlightCode(clean(string(args.python)).replace(/\t/g, "   ").trimEnd(), "python").join("\n")
  return [expanded ? new Text(code, 0, 0) : preview(code, theme, 10, "start")]
}

// Script results read as inside the envelope: one record entry per line, values inline.
function resultText(value: unknown, theme: Theme): string {
  if (typeof value === "string") return theme.fg("toolOutput", clean(value))
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.keys(value).length) return json(JSON.stringify(value), theme)
  return json(`{\n${Object.entries(value).map(([key, item]) => `  ${JSON.stringify(key)}: ${JSON.stringify(item)}`).join(",\n")}\n}`, theme)
}

// A subagent's line names who answered apart from what it said.
function printedText(output: string, theme: Theme): string {
  return output.split("\n").map(line => {
    const [, label, reply] = /^(subagent \S+ \([\d.]+ s\):)(.*)$/.exec(line) ?? []
    if (label) return `${theme.fg("accent", label)}${theme.fg("toolOutput", reply ?? "")}`
    return theme.fg(line.startsWith("subagent failed:") ? "error" : "toolOutput", line)
  }).join("\n")
}

// A traceback leads to its last line: the frames recede and the exception stands out.
function failureText(error: string, theme: Theme): string {
  const lines = error.split("\n")
  if (lines.length === 1 || !lines[0]!.startsWith("Traceback")) return theme.fg("error", error)
  return [...lines.slice(0, -1).map(line => theme.fg("muted", line)), theme.fg("error", lines.at(-1)!)].join("\n")
}

// The exec envelope reads as printed output, then the result with the files attached to it, or the failure.
function execResult(text: string, theme: Theme, expanded: boolean): string | undefined {
  const value = object(parse(text))
  if (typeof value.output !== "string" || !("result" in value || "error" in value)) return undefined
  const { output, result, file, error, code, details } = value
  const printed = clean(output).trimEnd()
  const blocks = printed ? [printedText(printed, theme)] : []
  if (typeof error === "string") {
    const failure = code !== undefined || details !== undefined ? `\n${theme.fg("error", formatJSON({ code, details }))}` : ""
    blocks.push(`${failureText(clean(error).trim(), theme)}${failure}`)
  }
  else if (result !== null && result !== undefined) blocks.push(resultText(expanded ? result : brief(result), theme))
  if (Array.isArray(file)) blocks.push(file.map(item => theme.fg("muted", `file ${string(item)}`)).join("\n"))
  return blocks.join("\n\n")
}

/** What a finished call shows under its title: the exec envelope, JSON as code, or the text as it came. */
function outcome(name: string, texts: string[], theme: Theme, options: { expanded: boolean, isError: boolean, compact?: boolean, durationMs?: number, lines?: number }): Component {
  const blocks = texts.map(block => {
    const exec = name === "exec" ? execResult(block, theme, options.expanded) : undefined
    if (exec !== undefined) return exec
    const text = clean(block)
    const value = parse(text)
    if (value === undefined) return theme.fg(options.isError ? "error" : "toolOutput", text)
    const formatted = formatJSON(options.expanded ? value : brief(value), options.compact)
    return options.isError ? theme.fg("error", formatted) : json(formatted, theme)
  })
  const output = blocks.filter(block => stripTerminalSequences(block).trim()).join("\n")
  // A program that took a moment says how long, below the output and outside its line budget.
  const took = name === "exec" && options.durationMs !== undefined && options.durationMs >= 1000 ? theme.fg("muted", `took ${(options.durationMs / 1000).toFixed(1)} s`) : ""
  // Bound visual lines, including deeply nested inline JSON and long paths; exec keeps its outcome.
  const shown = options.expanded ? new Text(output, 0, 0)
    : name === "exec" ? preview(output, theme, options.lines ?? 6, "end") : preview(output, theme, options.lines ?? 4, "start")
  return stack(...(output ? [new Spacer(1), shown] : []), ...(took ? [new Spacer(1), new Text(took, 0, 0)] : []))
}

export function toolRenderers(name: string): Pick<ToolDefinition, "renderCall" | "renderResult"> {
  return {
    renderCall(input, theme, context) {
      const args = object(input)
      const title = heading(name, summary(name, args), theme, context.expanded)
      const body = callBody(name, args, theme, context.expanded)
      // Blank lines separate the title, the call's body and the result, as in Pi's own rows.
      return body.length ? stack(title, new Spacer(1), ...body) : title
    },
    renderResult(result, options, theme, context) {
      return outcome(name, result.content.flatMap(block => block.type === "text" ? [block.text] : []), theme, {
        expanded: options.expanded, isError: context.isError, compact: name === "device" && object(context.args).compact === true, durationMs: context.durationMs,
      })
    },
  }
}

/** A command the user ran and, once it finished, what it returned. */
export interface CommandRow {
  name: string
  args: string
  result?: { text: string, isError: boolean, durationMs?: number, images?: { mimeType: string, data: string }[] }
}

/**
 * A user command drawn as the tool row it resembles: the same colours while it runs and
 * once it succeeds or fails, its name as the title and what it ran as the subject.
 * status is the row's live line while the command runs.
 */
export function commandRow(row: CommandRow, theme: Theme, options: { expanded: boolean, outputPad: number, status?: Component }): Component {
  const { result } = row
  const [subject = "", ...rest] = singleLine(row.args).split(" ")
  const box = new Box(options.outputPad, 1, text => theme.bg(!result ? "toolPendingBg" : result.isError ? "toolErrorBg" : "toolSuccessBg", text))
  box.addChild(heading(row.name, [subject, rest.join(" ")], theme, options.expanded))
  if (options.status) box.addChild(options.status)
  if (!result) return box
  // The user asked for this output, so the row shows far more of it than a row of the agent's own calls.
  box.addChild(outcome(row.name, [result.text], theme, { expanded: options.expanded, isError: result.isError, durationMs: result.durationMs, lines: 20 }))
  const images = getCapabilities().images ? result.images ?? [] : []
  return stack(box, ...images.flatMap(image => [new Spacer(1), new Image(image.data, image.mimeType, { fallbackColor: text => theme.fg("toolOutput", text) }, { maxWidthCells: 60 })]))
}

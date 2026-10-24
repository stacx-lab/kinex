import { highlightCode, keyHint, truncateToVisualLines, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent"
import { Container, Spacer, Text, TruncatedText, stripTerminalSequences, truncateToWidth, type Component } from "@earendil-works/pi-tui"
import { formatJSON } from "@kinex/core/util/json"

const tools = new Set(["device", "devices", "record", "device_stop", "exec"])
const string = (value: unknown) => typeof value === "string" ? value : ""
const clean = (value: string) => stripTerminalSequences(value).replace(/\r/g, "")
const singleLine = (value: string) => clean(value).replace(/[\n\t]/g, " ")
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {}
const quote = (arg: string) => /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`

function summary(name: string, args: Record<string, unknown>): string {
  if (name === "exec") return string(args.description).trim()
  if (name === "device") return `${string(args.action) || "read"} ${string(args.deviceID)}`.trim()
  if (name === "devices") return `${Array.isArray(args.calls) ? args.calls.length : 0} calls`
  if (name === "device_stop") return string(args.deviceID) || "all"
  if (name === "record") {
    const devices = Array.isArray(args.devices) ? args.devices.map(string).join(", ")
      : args.devices && typeof args.devices === "object"
        ? Object.entries(args.devices).map(([device, rate]) => `${device}=${typeof rate === "number" ? rate : "?"}Hz`).join(" ") : ""
    return [string(args.action), devices, string(args.outcome)].filter(Boolean).join(" ")
  }
  return ""
}

const timeFields = new Set(["time_s", "used_s", "waited_s", "max_s"])
const rounded = (key: string, value: unknown) => typeof value === "number" && timeFields.has(key) ? Number(value.toFixed(6)) : value
function parse(text: string): unknown {
  try { return JSON.parse(text, rounded) }
  catch { return undefined }
}

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

// The script is the call's body: highlighted inline source, or the command that runs a file.
function execCall(args: Record<string, unknown>, theme: Theme, expanded: boolean): Component[] {
  const body: Component[] = []
  const python = string(args.python)
  if (python) {
    const code = highlightCode(clean(python).replace(/\t/g, "   ").trimEnd(), "python").join("\n")
    body.push(expanded ? new Text(code, 0, 0) : preview(code, theme, 10, "start"))
  }
  const file = string(args.file)
  if (file) {
    const argv = Array.isArray(args.argv) ? args.argv.map(string) : []
    const command = ["python", file, ...argv].map(arg => quote(singleLine(arg))).join(" ")
    body.push(new Text(highlightCode(command, "bash").join("\n"), 0, 0))
  }
  const values = object(args.args)
  if (Object.keys(values).length) body.push(new Text(theme.fg("muted", `args ${formatJSON(values, true)}`), 0, 0))
  return body
}

// Script results read as inside the envelope: one record entry per line, values inline.
function resultText(value: unknown): string {
  if (typeof value === "string") return clean(value)
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.keys(value).length) return JSON.stringify(value)
  return `{\n${Object.entries(value).map(([key, item]) => `  ${JSON.stringify(key)}: ${JSON.stringify(item)}`).join(",\n")}\n}`
}

// The exec envelope reads as printed output, then the result or the failure.
function execResult(text: string, theme: Theme): string | undefined {
  const value = object(parse(text))
  if (typeof value.output !== "string" || !("result" in value || "error" in value)) return undefined
  const { output, result, error, code, details } = value
  const printed = clean(output).trimEnd()
  const blocks = printed ? [theme.fg("toolOutput", printed)] : []
  if (typeof error === "string") {
    const failure = code !== undefined || details !== undefined ? `\n${formatJSON({ code, details })}` : ""
    blocks.push(theme.fg("error", `${clean(error).trim()}${failure}`))
  }
  else if (result !== null && result !== undefined) blocks.push(theme.fg("toolOutput", resultText(result)))
  return blocks.join("\n\n")
}

export function toolRenderers(name: string): Pick<ToolDefinition, "renderCall" | "renderResult"> {
  return {
    renderCall(input, theme, context) {
      const args = object(input)
      const title = theme.fg("toolTitle", theme.bold(name))
      if (!tools.has(name)) return new TruncatedText(title, 0, 0)
      const label = singleLine(summary(name, args))
      // The subject reads like Pi's tool paths.
      const line = label ? `${title} ${theme.fg("accent", label)}` : title
      const body = name === "exec" ? execCall(args, theme, context.expanded)
        : context.expanded ? [new Text(theme.fg("muted", formatJSON(args)), 0, 0)] : []
      if (!body.length) return new TruncatedText(line, 0, 0)
      // Blank lines separate the title, the call's body and the result, as in Pi's own rows.
      return stack(context.expanded ? new Text(line, 0, 0) : new TruncatedText(line, 0, 0), new Spacer(1), ...body)
    },
    renderResult(result, options, theme, context) {
      const compact = name === "device" && object(context.args).compact === true
      const output = result.content.flatMap(block => {
        if (block.type !== "text") return []
        const exec = name === "exec" ? execResult(block.text, theme) : undefined
        if (exec !== undefined) return [exec]
        const text = clean(block.text)
        const value = parse(text)
        return [theme.fg(context.isError ? "error" : "toolOutput", value === undefined ? text : formatJSON(value, compact))]
      }).join("\n")
      if (!stripTerminalSequences(output).trim()) return new Container()
      // Bound visual lines, including deeply nested inline JSON and long paths; exec keeps its outcome.
      return stack(new Spacer(1), options.expanded ? new Text(output, 0, 0)
        : name === "exec" ? preview(output, theme, 6, "end") : preview(output, theme, 4, "start"))
    },
  }
}

import { keyHint, type ToolDefinition } from "@earendil-works/pi-coding-agent"
import { Container, Text, TruncatedText, stripTerminalSequences } from "@earendil-works/pi-tui"
import { formatJSON } from "@kinex/core/util/json"

const tools = new Set(["device", "devices", "record", "device_stop", "servo", "closed_loop", "exec"])
const string = (value: unknown) => typeof value === "string" ? value : ""
const singleLine = (value: string) => stripTerminalSequences(value).replace(/[\r\n\t]/g, " ")
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {}

function summary(name: string, args: Record<string, unknown>): string {
  if (name === "exec") return string(args.file) || string(args.python).split("\n")[0] || "Python"
  if (name === "device") return `${string(args.action) || "read"} ${string(args.deviceID)}`.trim()
  if (name === "devices") return `${Array.isArray(args.calls) ? args.calls.length : 0} calls`
  if (name === "device_stop") return string(args.deviceID) || "all"
  if (name === "closed_loop") {
    const control = object(args.control)
    return [string(object(control.args).device), string(object(args.perceive).tool)].filter(Boolean).join(" ")
  }
  if (name === "record") {
    const devices = Array.isArray(args.devices) ? args.devices.map(string).join(", ")
      : args.devices && typeof args.devices === "object"
        ? Object.entries(args.devices).map(([device, rate]) => `${device}=${typeof rate === "number" ? rate : "?"}Hz`).join(" ") : ""
    return [string(args.action), devices, string(args.outcome)].filter(Boolean).join(" ")
  }
  const goal = name === "servo" ? (args.joints ? "joints" : args.pose ? "pose" : args.observation ? "observation" : "") : string(args.mode)
  return [string(args.device), goal].filter(Boolean).join(" ")
}

const timeFields = new Set(["time_s", "used_s", "waited_s", "max_s"])
function jsonText(text: string, compact: boolean): string {
  try {
    return formatJSON(JSON.parse(text, (key: string, value: unknown) =>
      typeof value === "number" && timeFields.has(key) ? Number(value.toFixed(6)) : value), compact)
  }
  catch { return text }
}

export function toolRenderers(name: string, displayName = name): Pick<ToolDefinition, "renderCall" | "renderResult"> {
  return {
    renderCall(input, theme, context) {
      const args = object(input)
      const title = theme.fg("toolTitle", theme.bold(displayName))
      if (!tools.has(name)) return new TruncatedText(title, 0, 0)
      const line = `${title} ${theme.fg("muted", singleLine(summary(name, args)))}`.trimEnd()
      if (!context.expanded) return new TruncatedText(line, 0, 0)
      const container = new Container()
      container.addChild(new Text(line, 0, 0))
      container.addChild(new Text(theme.fg("muted", formatJSON(args)), 0, 0))
      return container
    },
    renderResult(result, options, theme, context) {
      const compact = name === "device" && object(context.args).compact === true
      const output = result.content.flatMap(block => {
        if (block.type !== "text") return []
        const text = stripTerminalSequences(block.text).replace(/\r/g, "")
        return [jsonText(text, compact)]
      }).join("\n")
      const text = new Text(theme.fg(context.isError ? "error" : "toolOutput", output), 0, 0)
      if (options.expanded) return text
      // Bound visual lines, including deeply nested inline JSON and long paths.
      return {
        invalidate: () => text.invalidate(),
        render(width) {
          const lines = text.render(width)
          if (lines.length <= 4) return lines
          return [...lines.slice(0, 4), ...new TruncatedText(theme.fg("muted", `… ${keyHint("app.tools.expand", "to expand")}`), 0, 0).render(width)]
        },
      }
    },
  }
}

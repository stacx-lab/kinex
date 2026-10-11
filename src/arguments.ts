import { parseArgs } from "@earendil-works/pi-coding-agent"
import type { Mode } from "./integration/interaction.ts"

const valued = new Set(["--model", "--provider", "--thinking", "--session", "--mode", "--export"])
const supported = new Set([
  "messages", "fileArgs", "unknownFlags", "diagnostics", "help", "version", "model", "provider",
  "thinking", "session", "continue", "resume", "mode", "print", "export",
])
const replacements: Record<string, string> = { seed: 'kinex "prompt"', json: "--mode json", effort: "--thinking" }

/** Pi owns common syntax; remove only Kinex options before handing it the arguments. */
export function parseKinexArgs(args: string[]) {
  if (args[0] === "run") args = ["--print", ...args.slice(1)]
  const common: string[] = []
  let auto = false, yolo = false, enableRecording = false, record: string | undefined
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === "--") { common.push(...args.slice(index)); break }
    if (arg === "--auto") { auto = true; continue }
    if (arg === "--yolo") { yolo = true; continue }
    if (arg === "--enable-recording") { enableRecording = true; continue }
    if (arg === "--record" || arg.startsWith("--record=")) {
      record = arg === "--record" ? args[++index] : arg.slice("--record=".length)
      if (!record || record.startsWith("-")) throw new Error('--record requires a device specification, e.g. "arm=10 camera=2"')
      continue
    }
    common.push(arg)
    if (valued.has(arg)) {
      const value = args[++index]
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`)
      common.push(value)
    }
  }
  const pi = parseArgs(common)
  for (const key of pi.unknownFlags.keys()) {
    if (replacements[key]) throw new Error(`--${key} was removed; use ${replacements[key]}`)
    throw new Error(`Unsupported option --${key}; see kinex --help`)
  }
  for (const key of Object.keys(pi)) {
    if (!supported.has(key)) throw new Error(`Unsupported Pi option (${key}); see kinex --help`)
  }
  const error = pi.diagnostics.find(diagnostic => diagnostic.type === "error")
  if (error) throw new Error(error.message)
  if (pi.fileArgs.length) throw new Error("CLI @file attachments are not supported; see kinex --help")
  if (pi.mode === "rpc") throw new Error("RPC mode is not supported; use --mode text or --mode json")
  if (pi.provider && !pi.model) throw new Error("--provider requires --model")
  if (auto && yolo) throw new Error("Choose --auto or --yolo")
  const mode: Mode = yolo ? "yolo" : auto ? "auto" : "ask"
  return { pi, mode, enableRecording, record }
}

export function isPrintMode(args: ReturnType<typeof parseKinexArgs>["pi"], stdinTTY: boolean, stdoutTTY: boolean): boolean {
  return args.mode === "json" || args.print === true || !stdinTTY || !stdoutTTY
}

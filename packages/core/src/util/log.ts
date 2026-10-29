const LEVELS = ["DEBUG", "INFO", "WARN", "ERROR"] as const
export type Level = (typeof LEVELS)[number]

function threshold(): number {
  const level = process.env["KINEX_LOG_LEVEL"]
  const index = LEVELS.indexOf(level as Level)
  return index === -1 ? 2 : index
}

function write(level: Level, service: string, message: string, extra?: Record<string, unknown>) {
  if (LEVELS.indexOf(level) < threshold()) return
  const suffix = extra ? " " + JSON.stringify(extra) : ""
  process.stderr.write(`${level} [${service}] ${message}${suffix}\n`)
}

export function create(service: string) {
  return {
    warn: (message: string, extra?: Record<string, unknown>) => write("WARN", service, message, extra),
  }
}

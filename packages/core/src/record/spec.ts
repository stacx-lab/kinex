import type { DeviceSpec, OperationSpec } from "./recorder.ts"
import { Format } from "./schema.ts"

const USAGE = "expected <device>=<Hz> or <device>.<operation>=<Hz>[:video|:bag], e.g. arm=10 cam.image=10 cam.depth=2"

export function parseSpec(raw: string | number): { rate: number } | string {
  const rate = Number(raw)
  if (!String(raw).trim() || !Number.isFinite(rate) || rate <= 0) return `${raw}: expected a positive rate in Hz`
  return { rate }
}

// A device's name may hold dots, so a key that names a known device is that device.
function target(key: string, devices: ReadonlySet<string>) {
  const dot = key.lastIndexOf(".")
  if (devices.has(key) || dot <= 0 || dot === key.length - 1) return { device: key }
  return { device: key.slice(0, dot), operation: key.slice(dot + 1) }
}

/**
 * Recording specs from command tokens, then the instruction. `arm=10` records every declared
 * topic of arm at 10 Hz; `cam.depth=2` gives one operation its own rate, and `cam.image=10:bag`
 * its format. A device named only by its operations records those alone.
 */
export function parseSpecs(tokens: string[], devices: Iterable<string> = []): { specs: Record<string, DeviceSpec>; instruction: string } {
  const specs: Record<string, DeviceSpec> = {}, known = new Set(devices)
  const index = tokens.findIndex((token) => !token.includes("="))
  const heads = index === -1 ? tokens : tokens.slice(0, index)
  for (const token of heads) {
    const [key = "", raw = "", ...extra] = token.split("=")
    const [hz = "", format, ...more] = raw.split(":")
    const rate = parseSpec(hz), { device, operation } = target(key, known)
    const kept = format === undefined ? undefined : Format.safeParse(format)
    if (!device || extra.length || more.length || typeof rate === "string" || kept?.success === false || (kept && !operation))
      throw new Error(`${token}: ${USAGE}`)
    const spec = specs[device] ??= {}
    if (!operation) { spec.rate = rate.rate; continue }
    const operations = spec.operations && !Array.isArray(spec.operations) ? spec.operations : {}
    operations[operation] = { rate: rate.rate, ...(kept ? { format: kept.data } : {}) }
    spec.operations = operations
  }
  return { specs, instruction: (index === -1 ? [] : tokens.slice(index)).join(" ") }
}

/** Specs in the command's own form, for a permission prompt or a summary. */
export function describeSpecs(specs: Record<string, DeviceSpec>): string {
  return Object.entries(specs).flatMap(([device, spec]) => {
    const own = Array.isArray(spec.operations) ? spec.operations.map(name => [name, {}] as const)
      : Object.entries(spec.operations ?? {}).map(([name, value]) => [name, typeof value === "number" ? { rate: value } : value] as const)
    const whole = spec.rate !== undefined && !Array.isArray(spec.operations) ? [`${device}=${spec.rate}`] : []
    return [...whole, ...own.map(([name, value]: readonly [string, OperationSpec]) =>
      `${device}.${name}=${value.rate ?? spec.rate ?? "?"}${value.format ? `:${value.format}` : ""}`)]
  }).join(" ")
}

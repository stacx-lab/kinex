// Output-only cleanup. Paths are declared by the result owner; unknown fields,
// null, false and zero are never treated as empty. * traverses records/arrays.
export function omitEmptyOptional(value: unknown, paths: readonly string[]): unknown {
  if (!value || typeof value !== "object") return value
  const entries = Object.entries(value).flatMap(([key, child]) => {
    const nested = paths.flatMap(path => {
      const [head, ...tail] = path.split(".")
      return (head === key || head === "*") && tail.length ? [tail.join(".")] : []
    })
    const cleaned = nested.length ? omitEmptyOptional(child, nested) : child
    const optional = paths.includes(key) || paths.includes("*")
    const empty = cleaned === undefined || cleaned === "" ||
      (cleaned !== null && typeof cleaned === "object" && Object.keys(cleaned).length === 0)
    return optional && empty ? [] : [[key, cleaned]]
  })
  return Array.isArray(value) ? entries.map(([, child]) => child) : Object.fromEntries(entries)
}

// Indent the first two levels only. Deeper objects and arrays stay inline.
export function formatJSON(value: unknown, compact = false): string {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) return "null"
  if (compact) return serialized
  const render = (node: unknown, depth: number): string => {
    if (!node || typeof node !== "object" || depth >= 2) return JSON.stringify(node)
    const array = Array.isArray(node)
    const entries = Object.entries(node)
    if (!entries.length) return array ? "[]" : "{}"
    const indent = "  ".repeat(depth)
    const lines = entries.map(([key, child]) => `${indent}  ${array ? "" : `${JSON.stringify(key)}: `}${render(child, depth + 1)}`)
    return `${array ? "[" : "{"}\n${lines.join(",\n")}\n${indent}${array ? "]" : "}"}`
  }
  // Normalize undefined properties, toJSON and array holes using JSON semantics.
  return render(JSON.parse(serialized), 0)
}

import { z } from "zod"

const object = z.record(z.string(), z.unknown())

// A manifest path selects string leaves, e.g. devices[] or child.frame.
export function deviceInputSchema(schema: unknown, selector: string): unknown {
  return selector.split(".").reduce<unknown>((node, part) => {
    const properties = object.safeParse(object.safeParse(node).data?.["properties"]).data
    const child = properties?.[part.replace(/\[\]$/, "")]
    if (!part.endsWith("[]")) return child
    const array = object.safeParse(child).data
    return array?.["type"] === "array" ? array["items"] : undefined
  }, schema)
}

export function deviceInputValues(args: unknown, schema: unknown, selector: string): unknown[] {
  const [part, ...rest] = selector.split(".")
  if (!part) return [args]
  const key = part.replace(/\[\]$/, "")
  const node = object.safeParse(schema).data
  const properties = object.safeParse(node?.["properties"]).data
  const childSchema = properties?.[key]
  const value = object.safeParse(args).data?.[key]
  const required = node?.["required"]
  if (value === undefined && !(Array.isArray(required) && required.includes(key))) return []
  if (!part.endsWith("[]"))
    return rest.length ? deviceInputValues(value, childSchema, rest.join(".")) : [value]
  if (!Array.isArray(value)) return [undefined]
  const items = object.safeParse(childSchema).data?.["items"]
  return value.flatMap((entry: unknown) => rest.length ? deviceInputValues(entry, items, rest.join(".")) : [entry])
}

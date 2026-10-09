import { XMLParser } from "fast-xml-parser"
import { z } from "zod"

const rootSchema = z.object({ root: z.object({
  "@_name": z.string().min(1),
  "@_description": z.string().min(1),
  "@_tool": z.string().regex(/^[a-z][a-z0-9_]*$/),
  "@_main_tree_to_execute": z.string().min(1),
  "@_resolves": z.string().optional(),
  "@_requires": z.string().optional(),
}) })

/** Metadata only: never import Python or execute a tree during discovery. */
export function parseXMLSkill(text: string): Record<string, string> {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error("XML skills cannot declare DTDs or entities")
  const parsed: unknown = new XMLParser({ ignoreAttributes: false }).parse(text, true)
  const root = rootSchema.parse(parsed).root
  return Object.fromEntries(Object.entries(root).filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([key, value]) => [key.slice(2), value]))
}

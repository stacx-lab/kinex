import { shortID } from "@kinex/core/util/id"
import path from "node:path"
import { createHash } from "node:crypto"
import { readFile, mkdir, rename, writeFile, stat } from "node:fs/promises"
import { isDeepStrictEqual } from "node:util"
import { ProfileStore } from "@kinex/core/device/profile/store"
import { parse as parseYaml } from "yaml"
import { NamedError } from "@kinex/core/util/error"
import { Fact, RelativePath } from "./schema.ts"

export function fail(message: string): never { throw new NamedError("SetupPlanError", message) }
export function digest(value: unknown): string {
  const canonical = JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)
  return createHash("sha256").update(canonical ?? "undefined").digest("hex")
}
export async function location(cwd: string, relative: string) {
  return path.join(await ProfileStore.workspaceDir(cwd), RelativePath.parse(relative))
}
export async function optionalText(file: string): Promise<string | undefined> {
  return readFile(file, "utf8").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
    throw error
  })
}
export async function atomicJSON(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${shortID()}.tmp`
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n")
  await rename(temporary, file)
}
export function pointer(value: unknown, selector: string): unknown {
  let selected = value
  for (const part of selector.slice(1).split("/").map(part => part.replaceAll("~1", "/").replaceAll("~0", "~"))) {
    if (!selected || typeof selected !== "object" || !Object.hasOwn(selected, part)) return undefined
    selected = Reflect.get(selected, part)
  }
  return selected
}
export function known(value: unknown): boolean {
  if (value === undefined || value === "???") return false
  if (value && typeof value === "object") return Object.values(value).every(known)
  return true
}
/** Raw descriptions only: inspecting a plan must never resolve URDFs or prepare Python. */
export async function profile(cwd: string, device?: string): Promise<unknown> {
  const file = await location(cwd, device ? `devices/${device}/profile.yaml` : "workspace.yaml")
  const text = await optionalText(file)
  return text === undefined ? undefined : parseYaml(text)
}
export async function missingFacts(cwd: string, facts: Fact[]) {
  const available = await Promise.all(facts.map(async fact => {
    if (fact.kind === "file") {
      const file = path.isAbsolute(fact.path) ? fact.path : await location(cwd, fact.path)
      return stat(file).then(info => info.isFile()).catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return false
        throw error
      })
    }
    const value = pointer(await profile(cwd, fact.device), fact.pointer)
    return known(value) && (!Object.hasOwn(fact, "value") || isDeepStrictEqual(value, fact.value))
  }))
  return facts.filter((_fact, index) => !available[index])
}
export async function inspectFacts(cwd: string, facts: Fact[]) {
  const values = await Promise.all(facts.map(async fact => {
    if (fact.kind === "file") {
      const file = path.isAbsolute(fact.path) ? fact.path : await location(cwd, fact.path)
      const bytes = await readFile(file).catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
        throw error
      })
      return { fact, value: bytes ? createHash("sha256").update(bytes).digest("hex") : undefined, available: bytes !== undefined }
    }
    const value = pointer(await profile(cwd, fact.device), fact.pointer)
    return { fact, value, available: known(value) && (!Object.hasOwn(fact, "value") || digest(value) === digest(fact.value)) }
  }))
  return { hash: digest(values), missing: values.filter(value => !value.available).map(value => value.fact), values }
}

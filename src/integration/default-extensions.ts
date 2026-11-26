import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import type { ExtensionFactory, SettingsManager } from "@earendil-works/pi-coding-agent"

const require = createRequire(import.meta.url)

// Not every package exports its manifest, so a directory is found where Node looks packages up.
function packageDirectory(name: string): string {
  const found = (require.resolve.paths(name) ?? []).map(base => path.join(base, name)).find(directory => existsSync(path.join(directory, "package.json")))
  if (!found) throw new Error(`Bundled extension ${name} is not installed`)
  return found
}

/** Pi extensions standalone bundles, with their package directories. */
export function bundledExtensions(): { name: string; path: string }[] {
  return ["pi-web-search", "pi-btw", "pi-subagents"].map(name => ({ name, path: packageDirectory(name) }))
}

/** The bundled extension that stays closed until its gate opens; the others load as Pi packages. */
export const GATED = "pi-subagents"
/**
 * The loader pi-subagents keeps `subagent` behind on a model that can be given a tool
 * mid-conversation. The gate already keeps its tools out until they are wanted, so the
 * loader is never registered, and pi-subagents then leaves `subagent` active.
 */
export const LOADER = "subagents_enable"

/** Bundled extensions load unless the user's settings already configure that npm package. */
export function defaultExtensions(settings: SettingsManager): { name: string; path: string }[] {
  const configured = [
    ...settings.getGlobalSettings().packages ?? [],
    ...settings.getProjectSettings().packages ?? [],
  ].map(pkg => typeof pkg === "string" ? pkg : pkg.source)
  return bundledExtensions().filter(({ name }) => !configured.some(source => source === `npm:${name}` || source.startsWith(`npm:${name}@`)))
}

/**
 * Keeps an extension closed: it loads and follows the session, but the tools, commands
 * and shortcuts it registers reach the session only once the gate is open, so until
 * then neither the model nor the user sees anything of it. Open stays open. A tool named
 * in `never` is not registered at all.
 */
export function createGate(open = false, never: readonly string[] = []) {
  let held: (() => void)[] = []
  return {
    extension(load: () => Promise<ExtensionFactory>): ExtensionFactory {
      return async pi => {
        // What an earlier session held back was for that session.
        held = []
        const factory = await load()
        await factory(new Proxy(pi, {
          get(target, key) {
            const value: unknown = Reflect.get(target, key)
            if (typeof value !== "function") return value
            if (key !== "registerTool" && key !== "registerCommand" && key !== "registerShortcut") return value.bind(target)
            return (...args: unknown[]) => {
              const [tool] = args
              if (key === "registerTool" && tool && typeof tool === "object" && "name" in tool && never.some(name => name === tool.name)) return
              if (open) value.apply(target, args)
              else held.push(() => { value.apply(target, args) })
            }
          },
        }))
      }
    },
    open() {
      open = true
      for (const register of held.splice(0)) register()
    },
  }
}

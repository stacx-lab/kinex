import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import type { SettingsManager } from "@earendil-works/pi-coding-agent"

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

/** Bundled extensions load unless the user's settings already configure that npm package. */
export function defaultExtensionPaths(settings: SettingsManager): string[] {
  const configured = [
    ...settings.getGlobalSettings().packages ?? [],
    ...settings.getProjectSettings().packages ?? [],
  ].map(pkg => typeof pkg === "string" ? pkg : pkg.source)
  return bundledExtensions()
    .filter(({ name }) => !configured.some(source => source === `npm:${name}` || source.startsWith(`npm:${name}@`)))
    .map(extension => extension.path)
}

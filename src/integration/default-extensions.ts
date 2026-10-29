import { createRequire } from "node:module"
import path from "node:path"
import type { SettingsManager } from "@earendil-works/pi-coding-agent"

const require = createRequire(import.meta.url)

/** Pi extensions standalone bundles, with their package directories. */
export function bundledExtensions(): { name: string; path: string }[] {
  return ["pi-web-search", "pi-btw"].map(name => ({ name, path: path.dirname(require.resolve(`${name}/package.json`)) }))
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

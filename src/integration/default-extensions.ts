import { setupPiExtensions } from "@kinex/setup/extensions"
import type { SettingsManager } from "@earendil-works/pi-coding-agent"

export function defaultExtensionPaths(settings: SettingsManager): string[] {
  const configured = [
    ...settings.getGlobalSettings().packages ?? [],
    ...settings.getProjectSettings().packages ?? [],
  ].map(pkg => typeof pkg === "string" ? pkg : pkg.source)
  return setupPiExtensions()
    .filter(({ name }) => !configured.some(source => source === `npm:${name}` || source.startsWith(`npm:${name}@`)))
    .map(extension => extension.path)
}

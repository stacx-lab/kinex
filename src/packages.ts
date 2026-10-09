import { parseArgs } from "node:util"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { DefaultPackageManager, type SettingsManager } from "@earendil-works/pi-coding-agent"
import { setupPiExtensions } from "@kinex/setup/extensions"
import { defaultExtensionPaths } from "./integration/default-extensions.ts"
import { paths, settings } from "./settings.ts"
import { upgradeKinex } from "./upgrade.ts"

const usages: Record<string, string> = {
  install: "kinex install <source> [-l, --local]",
  remove: "kinex remove <source> [-l, --local]",
  uninstall: "kinex uninstall <source> [-l, --local]",
  list: "kinex list",
  update: "kinex update [source]",
  upgrade: "kinex upgrade [--all]",
}

function checkSettings(manager: SettingsManager): void {
  const errors = manager.drainErrors()
  if (errors.length) throw new Error(errors.map(error => String(error.error)).join("\n"))
}

/** Management commands never construct an agent session or execute package extensions. */
export async function runPackageCommand(args: string[], cwd = process.cwd()): Promise<boolean> {
  const command = args[0]
  if (!command || !Object.hasOwn(usages, command)) return false
  const scoped = command === "install" || command === "remove" || command === "uninstall"
  const { values, positionals } = parseArgs({
    args: args.slice(1), allowPositionals: true, strict: true,
    options: {
      help: { type: "boolean", short: "h" },
      ...(scoped ? { local: { type: "boolean" as const, short: "l" } } : {}),
      ...(command === "upgrade" ? { all: { type: "boolean" as const } } : {}),
    },
  })
  if (values.help) {
    console.log(`Usage: ${usages[command]}\n\nSources: npm:package[@version], git:host/owner/repo[@ref], or a local directory.\nInstalls default to the Kinex user scope; --local selects this project.\nupdate preserves version/ref pins. upgrade updates Kinex and its bundled Pi; --all also updates packages.`)
    return true
  }
  if (positionals.length > (scoped || command === "update" ? 1 : 0) ||
    (scoped && !positionals[0]) || positionals.some(source => !source.trim())) throw new Error(`Usage: ${usages[command]}`)
  if (command === "upgrade") {
    await upgradeKinex({ all: values.all === true, cwd })
    return true
  }
  const manager = settings(cwd)
  checkSettings(manager)
  const packages = new DefaultPackageManager({ cwd, agentDir: paths().agent, settingsManager: manager })
  packages.setProgressCallback(event => {
    if (event.type === "start" || event.type === "error") console.error(event.message ?? `${event.action}: ${event.source}`)
  })
  try {
    const source = positionals[0]
    if (command === "list") {
      for (const pkg of packages.listConfiguredPackages()) {
        console.log(`${pkg.scope}\t${pkg.source}${pkg.filtered ? " (resource filters)" : ""}\t${pkg.installedPath ?? "not installed"}`)
      }
      const defaults = new Set(defaultExtensionPaths(manager))
      for (const bundled of setupPiExtensions()) {
        const manifest = JSON.parse(await readFile(path.join(bundled.path, "package.json"), "utf8"))
        console.log(`bundled\t${bundled.name}@${manifest.version}\t${defaults.has(bundled.path) ? "fallback active" : "overridden"}\t${bundled.path}`)
      }
    } else if (command === "update") {
      if (["1", "true"].includes(process.env.PI_OFFLINE ?? "")) throw new Error("PI_OFFLINE disables package updates")
      await packages.update(source)
      console.log("Package update finished; version/ref pins were preserved. Restart running Kinex sessions.")
    } else if (source) {
      if (command === "install") {
        await packages.installAndPersist(source, { local: values.local === true })
        console.log(`Installed ${source} for ${values.local ? "this project" : "the Kinex user"}. Restart running Kinex sessions.`)
      } else {
        const removed = await packages.removeAndPersist(source, { local: values.local === true })
        if (!removed) throw new Error(`Package is not configured in this scope: ${source}`)
        console.log(`Removed ${source}. Bundled plugins fall back to their shipped version. Restart running Kinex sessions.`)
      }
    }
  } finally {
    await manager.flush()
    checkSettings(manager)
  }
  return true
}
